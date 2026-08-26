/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM source transformations return validated strings. */
/** Apply request-local cancellation and scoped routing to the Agent runtime. */
function replaceRequired(source, before, after) {
  if (!source.includes(before))
    throw new Error(
      `Company fallback patch anchor missing: ${before.slice(0, 100)}`,
    );
  return source.replace(before, after);
}

export function patchCompanyFallbackSafety(source, kind) {
  let next = source.replace(/\r\n/g, "\n");
  const marker = `JINGYU_COMPANY_FALLBACK_SAFETY_${kind.toUpperCase()}_V2`;
  if (next.includes(marker)) return finishCompanyFallbackSafety(next, kind);
  const change = (before, after) => {
    next = replaceRequired(next, before, after);
  };
  // Place the import after any future imports, at the existing logging import.
  change(
    "import logging\n",
    `import logging\nfrom agent import desktop_fallback as _desktop_fb\n# ${marker}\n`,
  );
  if (kind === "helpers") {
    // The new request-local deadline replaces the earlier Responses-only TTFB
    // override; keeping a second watchdog at exactly 30s would race cancellation.
    const first = next.indexOf(
      "    # HERMES_DESKTOP_COMPANY_RESPONSES_FALLBACK: fail over",
    );
    const last = next.indexOf("    if _ttfb_timeout <= 0:", first);
    if (first < 0 || last < 0) throw new Error("Legacy TTFB policy missing");
    next = next.slice(0, first) + next.slice(last);
    const gateStart = next.indexOf(
      "    # HERMES_DESKTOP_COMPANY_RESPONSES_FALLBACK: the managed",
    );
    const gateEnd = next.indexOf(
      "    if reason in {FailoverReason.rate_limit,",
      gateStart,
    );
    if (gateStart < 0 || gateEnd < 0)
      throw new Error("Legacy fallback gate missing");
    next =
      next.slice(0, gateStart) +
      `    if _desktop_fb.is_company(agent) and not _desktop_fb.allowed(agent, reason):
        return False
` +
      next.slice(gateEnd);
    change(
      `    fb = agent._fallback_chain[agent._fallback_index]
    agent._fallback_index += 1`,
      `    fb = agent._fallback_chain[agent._fallback_index]
    agent._fallback_index += 1
    if _desktop_fb.is_managed(fb) and not _desktop_fb.is_company(agent):
        return agent._try_activate_fallback(reason)  # Never send other providers' data to AIHub.`,
    );
    change(
      `        if _explicit_fb_api_mode:
            pass`,
      `        if _explicit_fb_api_mode in {"chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"}:
            pass`,
    );
    // Both protocols capture the deadline before starting their worker. The
    // deadline belongs to one logical API step, shared by its quick retry.
    change(
      `    _call_start = time.time()
`,
      `    _desktop_deadline = getattr(agent, "_desktop_first_response_deadline", None)
    _call_start = time.time()
`,
    );
    change(
      `        _poll_count += 1
`,
      `        _poll_count += 1
        _desktop_received = (
            result["response"] is not None
            or (_codex_watchdog_enabled and getattr(agent, "_codex_stream_last_event_ts", None) is not None)
        )
        if t.is_alive() and _desktop_fb.expired(_desktop_deadline, _desktop_received):
            _desktop_fb.abort_for_fallback(agent, t, _close_request_client_once, _request_cancelled)
`,
    );
    change(
      `    t = threading.Thread(target=_context_thread_target(_call), daemon=True)
    t.start()
    _last_heartbeat = time.time()`,
      `    _desktop_deadline = getattr(agent, "_desktop_first_response_deadline", None)
    _desktop_initial_chunk_time = last_chunk_time["t"]
    t = threading.Thread(target=_context_thread_target(_call), daemon=True)
    t.start()
    _last_heartbeat = time.time()`,
    );
    change(
      `        _hb_now = time.time()
`,
      `        _desktop_received = last_chunk_time["t"] != _desktop_initial_chunk_time or result["response"] is not None
        if t.is_alive() and _desktop_fb.expired(_desktop_deadline, _desktop_received):
            _cancel_current_stream_attempt("desktop_first_response_timeout")
            _desktop_fb.abort_for_fallback(agent, t, _close_request_client_once, _request_cancelled)
        _hb_now = time.time()
`,
    );
    // The outer loop owns the single quick retry. Avoid hidden stream retries
    // multiplying the 30s budget or delaying an immediate 503 failover.
    change(
      `        _max_stream_retries = env_int("HERMES_STREAM_RETRIES", 2)`,
      `        _max_stream_retries = 0 if _desktop_fb.has_backup(agent) else env_int("HERMES_STREAM_RETRIES", 2)`,
    );
    // Do not claim success silently: status carries the actual runtime identity
    // without changing the user's saved model or a different session.
    change(
      `        agent._fallback_activated = True`,
      `        agent._fallback_activated = True
        if _desktop_fb.is_managed(fb):
            agent._emit_status("主线路暂不可用，已切换至 AIHub / gpt-5.6-terra 备用线路。")`,
    );
  } else if (kind === "loop") {
    change(
      `                def _perform_api_call(next_api_kwargs):`,
      `                def _perform_api_call(next_api_kwargs):
                    _desktop_fb.begin_request(agent, retry_count)`,
    );
    // Fail closed when a worker cannot be joined. No new client, retry, tool
    // execution or provider swap is allowed while it may still mutate state.
    change(
      `            except Exception as api_error:
`,
      `            except Exception as api_error:
                if isinstance(api_error, _desktop_fb.RequestStillRunning):
                    if thinking_spinner:
                        thinking_spinner.stop("")
                        thinking_spinner = None
                    agent._emit_status(str(api_error))
                    agent._persist_session(messages, conversation_history)
                    return {"final_response": str(api_error), "messages": messages,
                            "api_calls": api_call_count, "completed": False,
                            "failed": True, "error": str(api_error)}
                agent._desktop_fallback_http_status = getattr(api_error, "status_code", None)
`,
    );
    const start = next.indexOf(
      "                # HERMES_DESKTOP_COMPANY_RESPONSES_FALLBACK_LOOP:",
    );
    const end = next.indexOf("                if _should_fallback and", start);
    if (start < 0 || end < 0) throw new Error("Legacy loop policy missing");
    next =
      next.slice(0, start) +
      `                _should_fallback = (
                    _desktop_fb.should_switch(agent, classified, api_error, retry_count)
                    if _desktop_fb.has_backup(agent)
                    else is_rate_limited or (_is_transport_failure and retry_count >= 2)
                )
` +
      next.slice(end);
    change(
      `                    and not _retry.auth_failover_attempted`,
      `                    and not _desktop_fb.is_company(agent)
                    and not _retry.auth_failover_attempted`,
    );
    change(
      `                    if agent._has_pending_fallback():
                        if classified.reason == FailoverReason.content_policy_blocked:`,
      `                    if agent._has_pending_fallback() and (not _desktop_fb.is_company(agent) or _desktop_fb.allowed(agent, classified.reason)):
                        if classified.reason == FailoverReason.content_policy_blocked:`,
    );
    change(
      `                    if _truly_empty and (not _has_structured or _prefill_exhausted) and agent._empty_content_retries < 3:`,
      `                    if _truly_empty and not _has_structured and _desktop_fb.has_backup(agent):
                        agent._empty_content_retries = 3  # Empty output goes straight to backup, not three more primary calls.
                    if _truly_empty and (not _has_structured or _prefill_exhausted) and agent._empty_content_retries < 3:`,
    );
  }
  return finishCompanyFallbackSafety(next, kind);
}

function finishCompanyFallbackSafety(source, kind) {
  const marker = `JINGYU_COMPANY_FALLBACK_FINAL_${kind.toUpperCase()}`;
  if (source.includes(marker)) return patchCompanyAuthFallback(source, kind);
  let next = source;
  const change = (before, after) => {
    next = replaceRequired(next, before, after);
  };
  if (kind === "helpers") {
    change(
      `        if _desktop_fb.is_managed(fb):
            agent._emit_status("主线路暂不可用，已切换至 AIHub / gpt-5.6-terra 备用线路。")`,
      "",
    );
    change(
      `        _reset_stale_streak(agent)
        return True
    except Exception as e:`,
      `        _reset_stale_streak(agent)
        if _desktop_fb.is_managed(fb):
            agent._emit_status("主线路暂不可用，已切换至 AIHub / gpt-5.6-terra 备用线路。")
        return True
    except Exception as e:`,
    );
  } else if (kind === "loop") {
    change(
      `                agent._desktop_fallback_http_status = getattr(api_error, "status_code", None)`,
      `                agent._desktop_fallback_http_status = getattr(api_error, "status_code", None)
                if _desktop_fb.is_company(agent) and _desktop_fb.visible_text(agent):
                    # Never retry a partially delivered answer and later fall back
                    # after the per-attempt delivery tracker has been cleared.
                    if thinking_spinner:
                        thinking_spinner.stop("")
                        thinking_spinner = None
                    partial = agent._strip_think_blocks(agent._current_streamed_assistant_text)
                    notice = "回复中途连接异常；为避免重复或混合不同模型的内容，未自动切换备用模型。请重试。"
                    messages.append({"role": "assistant", "content": partial + "\\n\\n" + notice})
                    agent._persist_session(messages, conversation_history)
                    return {"final_response": partial + "\\n\\n" + notice, "messages": messages,
                            "api_calls": api_call_count, "completed": False,
                            "failed": True, "error": notice}`,
    );
    change(
      `                _backoff_policy = None`,
      `                if _desktop_fb.has_backup(agent) and classified.reason in {FailoverReason.timeout, FailoverReason.server_error}:
                    wait_time = min(wait_time, 1.0)
                _backoff_policy = None`,
    );
  }
  return patchCompanyAuthFallback(next + `\n# ${marker}\n`, kind);
}

/** Upgrade both already-patched development runtimes and fresh release sources. */
function patchCompanyAuthFallback(source, kind) {
  if (kind !== "loop") return source;
  const marker = "JINGYU_COMPANY_AUTH_FALLBACK_V1";
  if (source.includes(marker)) return source;
  let next = replaceRequired(
    source,
    '                agent._desktop_fallback_http_status = getattr(api_error, "status_code", None)',
    "                _desktop_fb.record_error(agent, api_error)",
  );
  next = replaceRequired(
    next,
    "                        if _is_upstream:\n                            _upstream_name",
    `                        if _desktop_fb.is_company(agent) and getattr(agent, "_desktop_fallback_http_status", None) in {401, 403}:
                            # Do not echo upstream bodies: they can contain secrets.
                            _auth_kind = agent._desktop_fallback_auth_kind
                            logger.warning("Company fallback: status=%s category=%s",
                                           agent._desktop_fallback_http_status, _auth_kind)
                            agent._buffer_status("主线路鉴权或模型/账户权限异常，正在尝试备用线路。")
                        elif _is_upstream:
                            _upstream_name`,
  );
  // These legacy HTTP-200 refusal branches called fallback without a reason.
  // Preserve their policy signal at the final gate, not just the HTTP handler.
  next = replaceRequired(
    next,
    '                if finish_reason == "content_filter":',
    `                if finish_reason == "content_filter":
                    agent._desktop_fallback_policy_blocked = True`,
  );
  next = replaceRequired(
    next,
    `                    if agent._has_pending_fallback():
                        agent._buffer_status(
                            "⚠️ Model declined`,
    `                    if agent._has_pending_fallback() and not _desktop_fb.is_company(agent):
                        agent._buffer_status(
                            "⚠️ Model declined`,
  );
  next = replaceRequired(
    next,
    `                        if (
                            _cf_terminated
                            and agent._fallback_index`,
    `                        if _cf_terminated:
                            agent._desktop_fallback_policy_blocked = True
                        if (
                            _cf_terminated
                            and not _desktop_fb.is_company(agent)
                            and agent._fallback_index`,
  );
  return next + `\n# ${marker}\n`;
}

/** Keep the outer loop the sole retry owner for company Responses calls. */
export function patchCompanyCodexRetries(source) {
  const marker = "JINGYU_COMPANY_CODEX_RETRY_OWNER";
  if (source.includes(marker)) return source.replace(/\r\n/g, "\n");
  return replaceRequired(
    source.replace(/\r\n/g, "\n"),
    "    max_stream_retries = 1",
    `    from agent import desktop_fallback as _desktop_fb
    # ${marker}
    max_stream_retries = 0 if _desktop_fb.has_backup(agent) else 1`,
  );
}
