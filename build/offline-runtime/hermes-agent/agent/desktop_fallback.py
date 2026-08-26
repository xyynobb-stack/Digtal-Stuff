"""Company-gateway failover policy. No global model or credential mutation."""
from __future__ import annotations

import time
import logging
import json
import re
from urllib.parse import urlsplit


class FirstResponseTimeout(TimeoutError):
    """The primary spent its first-response budget without an event."""


class RequestStillRunning(RuntimeError):
    """Fail closed instead of letting an old worker race a new runtime."""


def is_company(agent):
    try:
        url = urlsplit(str(getattr(agent, "base_url", "") or ""))
        return url.hostname == "183.230.227.39" and url.port == 18600
    except ValueError:
        return False


def is_managed(entry):
    return (
        str(entry.get("base_url", "")).rstrip("/") == "https://aihub.dog/v1"
        and entry.get("key_env") == "AIHUB_API_KEY"
        and entry.get("model") == "gpt-5.6-terra"
    )


def has_backup(agent):
    if not is_company(agent):
        return False
    from hermes_cli.fallback_config import resolve_entry_api_key
    chain = getattr(agent, "_fallback_chain", []) or []
    index = getattr(agent, "_fallback_index", 0)
    return any(is_managed(entry) and resolve_entry_api_key(entry)
               for entry in chain[index:])


def visible_text(agent):
    text = getattr(agent, "_current_streamed_assistant_text", "") or ""
    strip = getattr(agent, "_strip_think_blocks", lambda value: value)
    return bool(strip(text).strip())


def _error_signals(error):
    """Read error fields only, never request bodies/headers or arbitrary metadata."""
    codes, messages = set(), []

    def visit(body, depth=0):
        if depth > 4:
            return
        if isinstance(body, str):
            body = body[:32768]
            try:
                parsed = json.loads(body)
            except (ValueError, TypeError):
                messages.append(body.lower())
            else:
                if isinstance(parsed, dict):
                    visit(parsed, depth + 1)
                else:
                    messages.append(body.lower())
        elif isinstance(body, dict):
            for key in ("code", "type"):
                value = body.get(key)
                if isinstance(value, str):
                    codes.add(value.strip().lower())
            for key in ("message", "error", "detail"):
                value = body.get(key)
                if isinstance(value, (str, dict)):
                    visit(value, depth + 1)

    body = getattr(error, "body", None)
    if body is None:
        response = getattr(error, "response", None)
        if response is not None:
            try:
                body = response.json()
            except (ValueError, TypeError, AttributeError):
                pass
    visit(body)
    for field in ("code", "type"):
        value = getattr(error, field, None)
        if isinstance(value, str):
            codes.add(value.strip().lower())
    if not messages:
        visit(getattr(error, "message", None) or str(error))
    return codes, "\n".join(messages)


def record_error(agent, error, status=None):
    """Keep only a sanitized, request-local decision; safety overrides auth."""
    if status is None:
        status = getattr(error, "status_code", None)
    if status is None:
        status = getattr(getattr(error, "response", None), "status_code", None)
    try:
        status = int(status) if status is not None else None
    except (TypeError, ValueError):
        status = None
    codes, message = _error_signals(error)
    policy = bool(codes & {
        "content_policy_violation", "content_policy_blocked", "content_filter",
        "content_filter_error", "safety_violation", "safety_refusal",
        "moderation_blocked", "policy_violation", "responsible_ai_policy_violation",
    }) or any(term in message for term in (
        "content policy", "content_policy", "content filter", "content_filter",
        "safety policy", "safety refusal", "safety violation", "moderation",
        "usage policy", "usage policies", "policy violation", "guardrail",
        "内容安全", "内容策略", "内容政策", "安全策略", "安全政策", "合规拒绝", "违反使用政策",
    ))
    kind = "policy" if policy else "unknown"
    if not policy and status == 401:
        kind = "authentication"
    elif not policy and status == 403 and not re.search(r"<\s*(?:!doctype|html|body)\b", message):
        if codes & {"model_not_allowed", "model_access_denied", "model_permission_denied"}:
            kind = "model_permission"
        elif codes & {"account_disabled", "account_deactivated", "account_suspended"}:
            kind = "account_disabled"
        elif re.search(
            r"\bmodel\s+[^\n]{1,160}?\s+is not allowed for (?:this|your|the) api key\b"
            r"|\b(?:you|this api key|your api key) (?:do not|does not) have access to (?:the )?model\b"
            r"|(?:无权|没有权限|无权限)(?:访问|使用)(?:该|此)?模型"
            r"|(?:该|此|当前)?(?:api\s*key|密钥).{0,24}(?:无权|没有权限|无权限)(?:访问|使用).{0,24}模型",
            message,
        ):
            kind = "model_permission"
        elif re.search(
            r"\b(?:your|this|the) account (?:is|has been) (?:disabled|deactivated|suspended)\b"
            r"|(?:账号|账户)(?:已被|已|被)(?:停用|禁用|冻结)", message,
        ):
            kind = "account_disabled"
    agent._desktop_fallback_http_status = status
    agent._desktop_fallback_auth_kind = kind
    agent._desktop_fallback_policy_blocked = policy


def allowed(agent, reason=None):
    if getattr(agent, "_interrupt_requested", False) or visible_text(agent):
        return False
    value = getattr(reason, "value", reason)
    if value == "content_policy_blocked" or getattr(agent, "_desktop_fallback_policy_blocked", False):
        return False
    if getattr(agent, "_desktop_fallback_http_status", None) in {401, 403}:
        return getattr(agent, "_desktop_fallback_auth_kind", None) in {
            "authentication", "model_permission", "account_disabled",
        }
    return value in {None, "rate_limit", "billing", "upstream_rate_limit",
                     "overloaded", "server_error", "timeout", "model_not_found"}


def should_switch(agent, classified, error, retry_count):
    record_error(agent, error, classified.status_code)
    if not has_backup(agent) or not allowed(agent, classified.reason):
        return False
    status = agent._desktop_fallback_http_status
    value = classified.reason.value
    if status in {401, 403}:
        return True
    if isinstance(error, FirstResponseTimeout):
        return True
    if status in {429, 502, 503, 504} or value in {
        "model_not_found", "rate_limit", "billing", "upstream_rate_limit"
    }:
        return True
    return retry_count >= 2 and (status == 500 or value in {"timeout", "overloaded"})


def begin_request(agent, retry_count):
    previous = getattr(agent, "_desktop_unfinished_request", None)
    if previous is not None:
        if previous.is_alive():
            raise RequestStillRunning("上次请求仍在关闭，请稍后重试或开启新会话。")
        agent._desktop_unfinished_request = None
    agent._desktop_fallback_http_status = None
    agent._desktop_fallback_auth_kind = None
    agent._desktop_fallback_policy_blocked = False
    if not has_backup(agent):
        agent._desktop_first_response_deadline = None
    elif retry_count == 0 or getattr(agent, "_desktop_first_response_deadline", None) is None:
        agent._desktop_first_response_deadline = time.monotonic() + 30.0


def expired(deadline, received):
    return deadline is not None and not received and time.monotonic() >= deadline


def abort_for_fallback(agent, thread, abort, cancelled):
    """Cancel only this request; never close another worker's shared client."""
    cancelled["value"] = True
    try:
        abort("desktop_first_response_timeout")
    except Exception:
        logging.getLogger(__name__).debug("Request abort failed", exc_info=True)
    finally:
        thread.join(timeout=0.5)
    if getattr(agent, "_interrupt_requested", False):
        raise InterruptedError("Agent interrupted during first-response timeout")
    if thread.is_alive():
        agent._desktop_unfinished_request = thread
        raise RequestStillRunning("主线路30秒未响应，旧请求仍在关闭；为避免竞态，本次未启动备用请求，请稍后重试。")
    raise FirstResponseTimeout("主线路30秒未收到首个响应事件，开始使用备用线路。")
