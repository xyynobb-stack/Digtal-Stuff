"""Offline policy + real worker watchdog tests, without sending user data."""
import ast
import importlib.util
import logging
import sys
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
AGENT = ROOT / "build/offline-runtime/hermes-agent"
sys.path.insert(0, str(AGENT))
from hermes_cli import fallback_config
from agent.error_classifier import FailoverReason, ClassifiedError, classify_api_error

spec = importlib.util.spec_from_file_location("desktop_fallback_under_test", ROOT / "resources/hermes-agent-overlays/agent/desktop_fallback.py")
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)

ENTRY = {"provider": "custom:aihub-responses", "model": "gpt-5.6-terra",
         "base_url": "https://aihub.dog/v1", "key_env": "AIHUB_API_KEY"}


def agent():
    return SimpleNamespace(base_url="http://36.212.61.62:18600/v1",
                           provider="company-platform-responses", api_mode="codex_responses",
                           _fallback_chain=[dict(ENTRY)], _fallback_index=0,
                           _current_streamed_assistant_text="", _interrupt_requested=False,
                           _strip_think_blocks=lambda text: text)


class CompanyFallbackTests(unittest.TestCase):
    def setUp(self):
        self.key = patch.object(fallback_config, "resolve_entry_api_key", lambda entry: "fake-test-key")
        self.key.start()
        self.addCleanup(self.key.stop)
        self.agent = agent()

    # @lat: [[provider-setup#Company gateway fallback#Offline policy and cancellation tests]]
    def test_budget_is_30_seconds_and_shared_by_quick_retry(self):
        with patch.object(policy.time, "monotonic", return_value=100):
            policy.begin_request(self.agent, 0)
        with patch.object(policy.time, "monotonic", return_value=110):
            policy.begin_request(self.agent, 1)
        self.assertEqual(self.agent._desktop_first_response_deadline, 130)
        with patch.object(policy.time, "monotonic", return_value=129.9):
            self.assertFalse(policy.expired(130, False))
        with patch.object(policy.time, "monotonic", return_value=130):
            self.assertTrue(policy.expired(130, False))
            self.assertFalse(policy.expired(130, True))

    def test_next_api_step_gets_fresh_budget(self):
        with patch.object(policy.time, "monotonic", return_value=100):
            policy.begin_request(self.agent, 0)
        with patch.object(policy.time, "monotonic", return_value=400):
            policy.begin_request(self.agent, 0)
        self.assertEqual(self.agent._desktop_first_response_deadline, 430)

    def test_other_providers_and_backup_do_not_get_primary_watchdog(self):
        for url in ["https://aihub.dog/v1", "http://other.example/v1", "http://36.212.61.62:18601/v1"]:
            self.agent.base_url = url
            policy.begin_request(self.agent, 0)
            self.assertIsNone(self.agent._desktop_first_response_deadline)

    def test_chat_completions_is_also_covered(self):
        self.agent.provider = "company-platform"
        self.agent.api_mode = "chat_completions"
        self.assertTrue(policy.has_backup(self.agent))

    def test_missing_key_or_exhausted_chain_does_not_enable_watchdog(self):
        with patch.object(fallback_config, "resolve_entry_api_key", return_value=None):
            self.assertFalse(policy.has_backup(self.agent))
        self.agent._fallback_index = 1
        self.assertFalse(policy.has_backup(self.agent))

    def test_fast_errors_and_quick_retry_policy(self):
        for status, reason in [(429, "rate_limit"), (502, "server_error"), (503, "overloaded"), (504, "timeout"), (404, "model_not_found")]:
            classified = ClassifiedError(FailoverReason(reason), status_code=status)
            self.assertTrue(policy.should_switch(self.agent, classified, RuntimeError(), 1), status)
        for status, reason in [(500, "server_error"), (None, "timeout")]:
            classified = ClassifiedError(FailoverReason(reason), status_code=status)
            self.assertFalse(policy.should_switch(self.agent, classified, RuntimeError(), 1))
            self.assertTrue(policy.should_switch(self.agent, classified, RuntimeError(), 2))

    def test_first_response_timeout_skips_primary_retry(self):
        error = policy.FirstResponseTimeout("no first event")
        classified = classify_api_error(error)
        self.assertEqual(classified.reason, FailoverReason.timeout)
        self.assertTrue(policy.should_switch(self.agent, classified, error, 1))

    def test_parameter_context_auth_and_safety_errors_are_not_masked(self):
        for value in ["auth", "auth_permanent", "format_error", "context_overflow", "payload_too_large", "content_policy_blocked", "ssl_cert_verification", "unknown"]:
            reason = FailoverReason(value)
            self.assertFalse(policy.allowed(self.agent, reason), value)
            self.assertFalse(policy.should_switch(self.agent, ClassifiedError(reason), RuntimeError(), 5), value)
        self.assertFalse(policy.should_switch(self.agent, ClassifiedError(FailoverReason.billing, status_code=403), RuntimeError(), 5))

    def auth_error(self, status, body):
        error = RuntimeError("HTTP request failed")
        error.status_code = status
        error.body = body
        return error

    # @lat: [[provider-setup#Company gateway fallback#Authentication and permission classification tests]]
    def test_authentication_and_explicit_permissions_switch_on_first_failure(self):
        cases = [
            (401, {"error": {"code": "invalid_api_key"}}, "authentication"),
            (401, {"error": {"type": "expired_token"}}, "authentication"),
            (401, "Unauthorized", "authentication"),
            (403, {"error": {"code": "model_not_allowed"}}, "model_permission"),
            (403, {"error": {"type": "model_access_denied"}}, "model_permission"),
            (403, {"error": {"code": "account_disabled"}}, "account_disabled"),
            (403, {"error": {"code": "account_suspended"}}, "account_disabled"),
            (403, {"error": {"type": "http_error", "message": '上游供应商返回 HTTP 403: Model "gpt-5.6-terra" is not allowed for this API key'}}, "model_permission"),
            (403, {"message": "You do not have access to model gpt-5.6-terra"}, "model_permission"),
            (403, {"error": {"message": "当前密钥无权限使用该模型"}}, "model_permission"),
            (403, {"message": "Your account has been disabled"}, "account_disabled"),
            (403, {"message": "账户已被停用"}, "account_disabled"),
        ]
        for status, body, kind in cases:
            with self.subTest(status=status, body=body):
                error = self.auth_error(status, body)
                classified = classify_api_error(error)
                self.assertTrue(policy.should_switch(self.agent, classified, error, 1))
                self.assertEqual(self.agent._desktop_fallback_auth_kind, kind)
                # The actual activation gate must accept the same decision.
                self.assertTrue(policy.allowed(self.agent, classified.reason))

    def test_policy_overrides_authentication_codes_and_messages(self):
        for status in (401, 403):
            for body in [
                {"error": {"code": "content_policy_violation", "message": "Your account is disabled"}},
                {"error": {"code": "model_not_allowed", "type": "safety_refusal"}},
                {"error": {"code": "account_disabled", "message": "Blocked by content policy"}},
                {"error": {"code": "invalid_api_key", "message": "内容安全策略拒绝"}},
                {"error": {"code": "account_disabled", "message": "Your account is disabled for violating usage policies"}},
            ]:
                with self.subTest(status=status, body=body):
                    error = self.auth_error(status, body)
                    self.assertFalse(policy.should_switch(self.agent, classify_api_error(error), error, 9))
                    self.assertFalse(policy.allowed(self.agent))

    def test_unknown_forbidden_and_broad_permission_words_stay_blocked(self):
        for body in [
            "Forbidden", "Permission denied", "not allowed", "Access denied",
            {"error": {"code": "permission_denied"}},
            {"error": {"message": "IP address not allowed"}},
            {"error": {"message": "Model request is not allowed in this region"}},
            '<html><body>Your account is disabled</body></html>',
            {"request": {"message": "Your account is disabled"}, "message": "Forbidden"},
        ]:
            with self.subTest(body=body):
                error = self.auth_error(403, body)
                self.assertFalse(policy.should_switch(self.agent, classify_api_error(error), error, 9))
                # Legacy no-reason fallbacks cannot bypass the unknown-403 gate.
                self.assertFalse(policy.allowed(self.agent))

    def test_json_string_and_response_body_are_supported_without_retaining_secrets(self):
        error = self.auth_error(403, '{"error":{"code":"model_not_allowed"}}')
        self.assertTrue(policy.should_switch(self.agent, classify_api_error(error), error, 1))
        error = RuntimeError("Forbidden")
        error.response = SimpleNamespace(status_code=403, json=lambda: {
            "error": {"code": "account_disabled", "message": "secret-test-sentinel"}})
        policy.record_error(self.agent, error)
        self.assertTrue(policy.allowed(self.agent, FailoverReason.auth))
        self.assertNotIn("secret-test-sentinel", repr(vars(self.agent)))

    def test_auth_decision_cannot_leak_into_next_request_or_other_agent(self):
        error = self.auth_error(403, {"error": {"code": "model_not_allowed"}})
        policy.record_error(self.agent, error)
        self.assertTrue(policy.allowed(self.agent, FailoverReason.auth))
        self.assertFalse(policy.allowed(agent(), FailoverReason.auth))
        policy.begin_request(self.agent, 0)
        self.assertIsNone(self.agent._desktop_fallback_auth_kind)
        self.assertFalse(policy.allowed(self.agent, FailoverReason.auth))

    def test_auth_fallback_still_requires_backup_and_no_partial_output_or_stop(self):
        error = self.auth_error(401, {"error": {"code": "invalid_api_key"}})
        classified = classify_api_error(error)
        for field, value in [("_current_streamed_assistant_text", "部分回复"),
                             ("_interrupt_requested", True),
                             ("base_url", "https://another.example/v1"),
                             ("_fallback_index", 1)]:
            a = agent()
            setattr(a, field, value)
            self.assertFalse(policy.should_switch(a, classified, error, 1))
        with patch.object(fallback_config, "resolve_entry_api_key", return_value=None):
            self.assertFalse(policy.should_switch(self.agent, classified, error, 1))

    def test_content_filter_no_reason_gate_stays_closed(self):
        self.agent._desktop_fallback_policy_blocked = True
        self.assertFalse(policy.allowed(self.agent))
        policy.begin_request(self.agent, 0)
        self.assertFalse(self.agent._desktop_fallback_policy_blocked)

    def test_actual_loop_decision_and_final_activation_guard_agree(self):
        # Execute the actual runtime decision and the first activation guard,
        # without constructing network clients or touching real credentials.
        tree = ast.parse((AGENT / "agent/conversation_loop.py").read_text(encoding="utf8"))
        decision = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                        and any(isinstance(t, ast.Name) and t.id == "_should_fallback" for t in node.targets))
        tree = ast.parse((AGENT / "agent/chat_completion_helpers.py").read_text(encoding="utf8"))
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                  and node.name == "try_activate_fallback")
        guard = next(node for node in fn.body if isinstance(node, ast.If))
        wrapper = ast.parse("def gate(agent, reason=None):\n    return True").body[0]
        wrapper.body.insert(0, guard)
        ns = {"_desktop_fb": policy}
        exec(compile(ast.fix_missing_locations(ast.Module(body=[wrapper], type_ignores=[])), "gate", "exec"), ns)
        for status, body, expected in [
            (401, "Unauthorized", True),
            (403, {"error": {"code": "model_not_allowed"}}, True),
            (403, "Forbidden", False),
            (401, {"error": {"code": "content_policy_violation"}}, False),
        ]:
            error = self.auth_error(status, body)
            classified = classify_api_error(error)
            policy.record_error(self.agent, error)
            ns.update(agent=self.agent, classified=classified, api_error=error, retry_count=1)
            exec(compile(ast.Module(body=[decision], type_ignores=[]), "decision", "exec"), ns)
            self.assertEqual(ns["_should_fallback"], expected)
            self.assertEqual(ns["gate"](self.agent, classified.reason), expected)

    def test_no_fallback_after_text_or_stop(self):
        self.agent._current_streamed_assistant_text = "已经回答的一部分"
        self.assertFalse(policy.allowed(self.agent, FailoverReason.server_error))
        self.agent._current_streamed_assistant_text = ""
        self.agent._interrupt_requested = True
        self.assertFalse(policy.allowed(self.agent, FailoverReason.timeout))

    def test_abort_joins_worker_before_allowing_switch(self):
        stop = threading.Event()
        worker = threading.Thread(target=stop.wait)
        worker.start()
        cancelled = {"value": False}
        with self.assertRaises(policy.FirstResponseTimeout):
            policy.abort_for_fallback(self.agent, worker, lambda reason: stop.set(), cancelled)
        self.assertFalse(worker.is_alive())
        self.assertTrue(cancelled["value"])

    def test_unstopped_worker_blocks_next_request(self):
        stop = threading.Event()
        worker = threading.Thread(target=stop.wait)
        worker.start()
        try:
            with self.assertRaises(policy.RequestStillRunning):
                policy.abort_for_fallback(self.agent, worker, lambda reason: None, {"value": False})
            with self.assertRaises(policy.RequestStillRunning):
                policy.begin_request(self.agent, 0)
        finally:
            stop.set()
            worker.join()
        policy.begin_request(self.agent, 0)
        self.assertIsNone(self.agent._desktop_unfinished_request)


class RealWatchdogTests(unittest.TestCase):
    def run_request(self, first_event):
        source = AGENT / "agent/chat_completion_helpers.py"
        tree = ast.parse(source.read_text(encoding="utf8"))
        fn = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "interruptible_api_call")
        ns = {"threading": threading, "time": time, "logging": logging,
              "logger": logging.getLogger(__name__), "os": __import__("os"),
              "_desktop_fb": policy, "should_use_direct_api_call": lambda a: False,
              "_check_stale_giveup": lambda a: None, "_reset_stale_streak": lambda a: None,
              "_is_openai_codex_backend": lambda a: False,
              "estimate_request_context_tokens": lambda kwargs: 1,
              "_env_float": lambda name, default: default,
              "_context_thread_target": lambda fn: fn}
        exec(compile(ast.Module(body=[fn], type_ignores=[]), str(source), "exec"), ns)
        a = agent()
        stop = threading.Event()
        exited = threading.Event()
        calls = []
        a._desktop_first_response_deadline = time.monotonic() + 0.04
        a._compute_non_stream_stale_timeout = lambda kwargs: 90
        a._touch_activity = lambda message: None
        a._create_request_openai_client = lambda **kwargs: object()
        a._abort_request_openai_client = lambda client, **kwargs: (calls.append("abort"), stop.set())
        a._close_request_openai_client = lambda client, **kwargs: calls.append("owner_close")
        def dispatch(agent, kwargs, *, make_client):
            make_client("test")
            try:
                if first_event:
                    agent._codex_stream_last_event_ts = time.time()
                    time.sleep(0.4)
                    return "healthy response"
                stop.wait(2)
                raise ConnectionError("socket aborted")
            finally:
                exited.set()
        ns["_dispatch_nonstreaming_api_request"] = dispatch
        if first_event:
            self.assertEqual(ns[fn.name](a, {"model": "test"}), "healthy response")
            self.assertNotIn("abort", calls)
        else:
            with self.assertRaises(policy.FirstResponseTimeout):
                ns[fn.name](a, {"model": "test"})
            self.assertIn("abort", calls)
        self.assertTrue(exited.is_set())
        self.assertIn("owner_close", calls)

    def test_silent_socket_is_aborted_without_waiting_90_seconds(self):
        self.run_request(False)

    def test_first_event_disables_short_deadline_for_healthy_long_response(self):
        self.run_request(True)


if __name__ == "__main__":
    unittest.main()
