"""Exercise Desktop route/creation/switch handlers offline, without an LLM."""
import ast
import hashlib
import json
import os
import subprocess
import unittest
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "resources/hermes-agent-overlays/tui_gateway/methods_desktop_cold_start.py"
URL = "http://company.example/v1"


def load_handlers():
    names = {"_configured_models", "_configured_api_mode", "_route_identity", "_resolve_model_route",
             "desktop_session_create", "session_model_set", "model_identity"}
    tree = ast.parse(SOURCE.read_text(encoding="utf-8"))
    functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    for node in functions:
        node.decorator_list = []
    namespace = {"json": json, "hashlib": hashlib}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
    namespace.update({
        "_desktop_resolve_model_route": namespace["_resolve_model_route"],
        "_desktop_route_identity": namespace["_route_identity"],
        "_ok": lambda rid, result: {"result": result},
        "_err": lambda rid, code, message: {"error": {"code": code, "message": message}},
        "_desktop_remove_model_switch_markers": lambda session: None,
        "_desktop_session_readiness_payload": lambda sid, session: {"session_id": sid},
    })
    return namespace


class EmployeeRoutesTests(unittest.TestCase):
    def setUp(self):
        self.ns = load_handlers()
        self.ctx = SimpleNamespace(user_providers={
            "company-platform": {"base_url": URL, "api_mode": "chat_completions", "models": ["deepseek-v4-flash"]},
            "company-platform-responses": {"base_url": URL, "api_mode": "codex_responses", "models": ["gpt-5.6-luna", "gpt-5.6-terra"]},
        }, custom_providers=[])
        self.sessions = {"live": {"agent": None}, "other": {"agent": None}}
        self.ns.update({"_sessions": self.sessions, "_model_picker_context": lambda agent: self.ctx})

    def resolve(self, model):
        return self.ns["_resolve_model_route"](self.ctx, "custom", model, URL)

    # @lat: [[model-selection#Employee phone model allowlist#Protocol-safe session routing]]
    def test_same_endpoint_routes_by_model_not_provider_order(self):
        for model in ["gpt-5.6-luna", "deepseek-v4-flash", "gpt-5.6-terra"]:
            route = self.resolve(model)
            expected = "chat_completions" if model.startswith("deepseek") else "codex_responses"
            self.assertEqual(route["api_mode"], expected)
        self.ctx.user_providers = dict(reversed(list(self.ctx.user_providers.items())))
        self.assertEqual(self.resolve("deepseek-v4-flash")["provider"], "company-platform")

    def test_cold_create_sets_protocol_before_first_build(self):
        self.ns["_desktop_original_session_create"] = lambda rid, params: {"result": {"session_id": "live"}}
        result = self.ns["desktop_session_create"](1, {"provider": "custom", "model": "gpt-5.6-luna", "base_url": URL})
        self.assertEqual(result["result"]["info"]["api_mode"], "codex_responses")
        self.assertEqual(self.sessions["live"]["model_override"]["provider"], "company-platform-responses")
        self.assertNotIn("model_override", self.sessions["other"])

    def test_migrated_transport_preserves_responses_route(self):
        cfg = self.ctx.user_providers["company-platform-responses"]
        cfg["transport"] = cfg.pop("api_mode")
        self.assertEqual(self.resolve("gpt-5.6-luna")["api_mode"], "codex_responses")

    def test_latest_selection_during_build_keeps_model_and_protocol_together(self):
        self.sessions["live"]["agent_build_started"] = True
        for model in ["gpt-5.6-luna", "deepseek-v4-flash", "gpt-5.6-terra"]:
            result = self.ns["session_model_set"](1, {"session_id": "live", "provider": "custom", "model": model, "base_url": URL})
            self.assertNotIn("error", result)
        session = self.sessions["live"]
        self.assertEqual(session["model_override"]["model"], "gpt-5.6-terra")
        self.assertEqual(session["model_override"]["api_mode"], "codex_responses")
        self.assertEqual(session["pending_model_switch"]["raw"], "gpt-5.6-terra --provider company-platform-responses")
        self.assertEqual(session["model_selection_generation"], 3)
        self.assertNotIn("pending_model_switch", self.sessions["other"])

    def test_live_switch_uses_named_route_and_never_persists_global_default(self):
        self.sessions["live"]["agent"] = SimpleNamespace(api_mode="chat_completions")
        self.sessions["live"]["pending_model_switch"] = {"raw": "obsolete --provider old"}
        calls = []
        def switch(sid, session, raw, **kwargs):
            calls.append((raw, kwargs))
            model, provider = raw.split(" --provider ")
            session["agent"].api_mode = self.ctx.user_providers[provider]["api_mode"]
            session["model_override"] = {"model": model, "provider": provider, "base_url": URL}
        self.ns["_apply_model_switch"] = switch
        for model in ["gpt-5.6-luna", "deepseek-v4-flash"]:
            result = self.ns["session_model_set"](1, {"session_id": "live", "provider": "custom", "model": model, "base_url": URL})
            self.assertNotIn("error", result)
        self.assertEqual(calls[0][0], "gpt-5.6-luna --provider company-platform-responses")
        self.assertEqual(calls[1][0], "deepseek-v4-flash --provider company-platform")
        self.assertTrue(all(call[1]["persist_override"] is False for call in calls))
        self.assertEqual(self.sessions["live"]["model_override"]["api_mode"], "chat_completions")
        self.assertNotIn("pending_model_switch", self.sessions["live"])

    def test_identity_recovers_named_protocol_from_runtime_custom_billing_class(self):
        self.sessions["live"]["agent"] = SimpleNamespace(api_mode="codex_responses", base_url=URL)
        self.ns["_session_info"] = lambda agent, session: {"provider": "custom", "model": "gpt-5.6-luna"}
        result = self.ns["model_identity"](1, {"session_id": "live"})["result"]
        self.assertEqual(result["provider"], "company-platform-responses")
        self.assertEqual(result["route_id"], self.resolve("gpt-5.6-luna")["route_id"])

    def test_running_turn_rejects_protocol_change_without_mutation(self):
        self.sessions["live"]["running"] = True
        before = dict(self.sessions["live"])
        result = self.ns["session_model_set"](1, {"session_id": "live", "provider": "custom", "model": "gpt-5.6-luna", "base_url": URL})
        self.assertEqual(result["error"]["code"], 4091)
        self.assertEqual(before, self.sessions["live"])

    def test_persisted_custom_identity_recovers_by_model_and_endpoint(self):
        script = (
            'import fs from "node:fs";'
            'import {patchDesktopProtocolRoutingSource as patch} from "./scripts/apply-offline-runtime-overlays.mjs";'
            'process.stdout.write(patch(fs.readFileSync("build/offline-runtime/hermes-agent/hermes_cli/runtime_provider.py", "utf8")));'
        )
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script], cwd=ROOT,
            capture_output=True, encoding="utf-8", check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        names = {"find_custom_provider_identity", "find_custom_provider_identity_by_model",
                 "canonical_custom_identity", "_normalize_base_url_for_match"}
        tree = ast.parse(result.stdout)
        functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
        ns = {
            "load_config": lambda: {"providers": self.ctx.user_providers},
            "get_compatible_custom_providers": lambda config: [],
            "custom_provider_slug": lambda name, key="": "custom:" + (key or name),
        }
        from typing import Any, Dict, Optional
        ns.update({"Any": Any, "Dict": Dict, "Optional": Optional})
        exec(compile(ast.Module(body=functions, type_ignores=[]), "runtime_provider.py", "exec"), ns)
        # An earlier provider for the same model on ANOTHER endpoint must not win.
        self.ctx.user_providers = {
            "unrelated": {"base_url": "http://other.example/v1", "models": ["gpt-5.6-luna"]},
            **self.ctx.user_providers,
        }
        for model, provider in [("gpt-5.6-luna", "company-platform-responses"), ("deepseek-v4-flash", "company-platform")]:
            self.assertEqual(ns["canonical_custom_identity"](base_url=URL, model=model), "custom:" + provider)


if __name__ == "__main__":
    unittest.main()
