"""Hermes tool adapter for the market-report chapter workflow."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from tools.market_report_workflow_state import (
    FINANCE_SECTION_ORDER,
    HR_SECTION_ORDER,
    MarketReportWorkflowStore,
    REQUIRED_RETRIEVAL_COLLECTION,
    SECTION_ORDER,
    WorkflowError,
)
from tools.registry import registry


WORKFLOW_STORE = MarketReportWorkflowStore()

MARKET_REPORT_WORKFLOW_SCHEMA: Dict[str, Any] = {
    "name": "market_report_workflow",
    "description": (
        "Manage three-wave generation of a seven-chapter market-analysis report. "
        f"Evidence must come from {REQUIRED_RETRIEVAL_COLLECTION}. Record every section in the returned wave atomically, "
        "request at most two focused supplement rounds, and finalize only after all waves are complete."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "status", "record_wave", "record_section", "request_supplement", "finalize", "reset"]},
            "report_type": {"type": "string", "enum": ["market", "hr", "finance"], "description": "Report family; market is the compatibility default."},
            "report_goal": {"type": "string", "description": "Required by start: the user's report goal and audience."},
            "retrieval_collection": {
                "type": "string",
                "enum": [REQUIRED_RETRIEVAL_COLLECTION],
                "description": f"Required by start and must be the collection returned by rag_client.py: {REQUIRED_RETRIEVAL_COLLECTION}.",
            },
            "initial_evidence_summary": {"type": "string", "description": "Optional compact summary/index of the initial batched evidence."},
            "sections": {
                "type": "array",
                "description": "Required by record_wave: every section in expected_sections, submitted together.",
                "items": {
                    "type": "object",
                    "properties": {
                        "section": {"type": "string", "enum": list(dict.fromkeys((*SECTION_ORDER, *HR_SECTION_ORDER, *FINANCE_SECTION_ORDER)))},
                        "content": {"type": "string", "description": "Complete section, maximum 6000 characters."},
                        "source_refs": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["section", "content"],
                },
            },
            "section": {"type": "string", "enum": list(dict.fromkeys((*SECTION_ORDER, *HR_SECTION_ORDER, *FINANCE_SECTION_ORDER))), "description": "Legacy single-section input; accepted only for a one-section wave."},
            "content": {"type": "string", "description": "Legacy single-section content, maximum 6000 characters."},
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

ANALYSIS_REPORT_WORKFLOW_SCHEMA = {
    **MARKET_REPORT_WORKFLOW_SCHEMA,
    "name": "analysis_report_workflow",
    "description": (
        "Manage dependency-wave generation for market, HR, or finance analysis reports. "
        f"Evidence must come from {REQUIRED_RETRIEVAL_COLLECTION}; report_type selects the section contract."
    ),
}

registry.register(
    name="analysis_report_workflow",
    toolset="skills",
    schema=ANALYSIS_REPORT_WORKFLOW_SCHEMA,
    handler=lambda args, **kw: market_report_workflow(args, kw.get("task_id")),
    check_fn=lambda: True,
    emoji="📊",
)
