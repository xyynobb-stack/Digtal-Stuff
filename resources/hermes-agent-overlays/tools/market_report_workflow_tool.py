"""Hermes tool adapter for the market-report chapter workflow."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from tools.market_report_workflow_state import MarketReportWorkflowStore, SECTION_ORDER, WorkflowError
from tools.registry import registry


WORKFLOW_STORE = MarketReportWorkflowStore()

MARKET_REPORT_WORKFLOW_SCHEMA: Dict[str, Any] = {
    "name": "market_report_workflow",
    "description": (
        "Manage strict staged generation of a full market-analysis report. "
        "Keep RAG retrieval batched, but call this tool to start the report, record exactly one chapter per model turn, "
        "request at most two focused supplement rounds, and finalize only after every chapter is complete."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "status", "record_section", "request_supplement", "finalize", "reset"]},
            "report_goal": {"type": "string", "description": "Required by start: the user's report goal and audience."},
            "initial_evidence_summary": {"type": "string", "description": "Optional compact summary/index of the initial batched evidence."},
            "section": {"type": "string", "enum": list(SECTION_ORDER), "description": "Required by record_section and must equal expected_section."},
            "content": {"type": "string", "description": "Required by record_section: complete current chapter, maximum 6000 characters."},
            "source_refs": {"type": "array", "items": {"type": "string"}, "description": "Evidence identifiers cited by this chapter."},
            "queries": {"type": "array", "items": {"type": "string"}, "description": "Required by request_supplement: focused evidence queries to send in one RAG batch."},
            "missing_evidence": {"type": "array", "items": {"type": "string"}, "description": "Evidence categories or fields still missing."},
        },
        "required": ["action"],
    },
}


def market_report_workflow(arguments: Dict[str, Any], task_id: Optional[str]) -> str:
    try:
        action = arguments.get("action", "")
        payload = {key: value for key, value in arguments.items() if key != "action"}
        result = WORKFLOW_STORE.execute(task_id or "default", action, **payload)
    except WorkflowError as exc:
        result = {"ok": False, "error": {"code": exc.code, "message": str(exc)}}
    return json.dumps(result, ensure_ascii=False)


registry.register(
    name="market_report_workflow",
    toolset="skills",
    schema=MARKET_REPORT_WORKFLOW_SCHEMA,
    handler=lambda args, **kw: market_report_workflow(args, kw.get("task_id")),
    check_fn=lambda: True,
    emoji="📑",
)
