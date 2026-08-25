"""Process-local state machine for staged market-report generation."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, Dict, Iterable, List, Mapping, Optional


SECTION_ORDER = (
    "0.1", "0.2", "0.3", "1.1", "1.2", "2.1", "2.2",
    "3", "4.1", "4.2", "5.1", "5.2", "6",
)

SECTION_SPECS: Mapping[str, Dict[str, Any]] = {
    "0.1": {"goal": "历史项目资产表", "evidence": ["A", "B", "C"], "depends_on": []},
    "0.2": {"goal": "人员能力与可用产能表", "evidence": ["D", "E"], "depends_on": []},
    "0.3": {"goal": "有证据支撑的能力矩阵", "evidence": [], "depends_on": ["0.1", "0.2"]},
    "1.1": {"goal": "需求侧市场地图", "evidence": ["H", "销售访谈"], "depends_on": ["0.3"]},
    "1.2": {"goal": "具名客户优先级", "evidence": ["H", "销售与业务负责人访谈"], "depends_on": ["0.3", "1.1"]},
    "2.1": {"goal": "可签约服务目录", "evidence": ["A", "C", "E"], "depends_on": ["0.3"]},
    "2.2": {"goal": "有证据支撑的差异化", "evidence": ["A", "B", "G", "销售访谈"], "depends_on": ["0.3"]},
    "3": {"goal": "存量客户扩展机会", "evidence": ["A", "B", "客户访谈"], "depends_on": ["0.3"]},
    "4.1": {"goal": "丢单与机会缺口清单", "evidence": ["销售访谈", "招标要求"], "depends_on": ["0.2", "0.3"]},
    "4.2": {"goal": "人员、工具、流程、渠道的缺口选择", "evidence": ["D", "F", "G", "业务负责人访谈"], "depends_on": ["0.3", "4.1"]},
    "5.1": {"goal": "当前市场趋势", "evidence": ["H"], "depends_on": ["0.3"]},
    "5.2": {"goal": "趋势与能力交叉后的业务启示", "evidence": [], "depends_on": ["0.3", "5.1"]},
    "6": {"goal": "决策建议与 90 天行动计划", "evidence": ["业务负责人访谈"], "depends_on": list(SECTION_ORDER[:-1])},
}

MAX_SECTION_CHARS = 6000
MAX_SUPPLEMENT_ROUNDS = 2
MAX_ACTIVE_TASKS = 128


class WorkflowError(ValueError):
    """A user-correctable workflow protocol violation."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class ReportState:
    report_goal: str
    initial_evidence_summary: str = ""
    sections: Dict[str, str] = field(default_factory=dict)
    sources: Dict[str, List[str]] = field(default_factory=dict)
    supplement_rounds: int = 0
    supplement_history: List[List[str]] = field(default_factory=list)
    capability_matrix: Optional[str] = None

    @property
    def expected_section(self) -> Optional[str]:
        return next((section for section in SECTION_ORDER if section not in self.sections), None)


class MarketReportWorkflowStore:
    """Serialize operations and isolate report state by Hermes task id."""

    def __init__(self, max_active_tasks: int = MAX_ACTIVE_TASKS):
        self._max_active_tasks = max_active_tasks
        self._states: "OrderedDict[str, ReportState]" = OrderedDict()
        self._lock = RLock()

    def execute(self, task_id: str, action: str, **arguments: Any) -> Dict[str, Any]:
        if not task_id or task_id == "default":
            raise WorkflowError("TASK_ID_REQUIRED", "章节状态必须绑定当前聊天任务，不能使用全局默认状态。")
        with self._lock:
            if action == "start":
                return self._start(task_id, arguments.get("report_goal"), arguments.get("initial_evidence_summary", ""))
            if action == "reset":
                existed = self._states.pop(task_id, None) is not None
                return {"ok": True, "action": action, "reset": existed}

            state = self._require_state(task_id)
            self._states.move_to_end(task_id)
            if action == "status":
                return self._status(state, action)
            if action == "record_section":
                return self._record_section(state, arguments.get("section"), arguments.get("content"), arguments.get("source_refs") or [])
            if action == "request_supplement":
                return self._request_supplement(state, arguments.get("queries") or [], arguments.get("missing_evidence") or [])
            if action == "finalize":
                return self._finalize(state)
            raise WorkflowError("INVALID_ACTION", f"未知动作：{action}")

    def _start(self, task_id: str, report_goal: Any, initial_evidence_summary: Any) -> Dict[str, Any]:
        goal = self._clean_text(report_goal, "report_goal")
        summary = str(initial_evidence_summary or "").strip()
        if len(summary) > MAX_SECTION_CHARS:
            raise WorkflowError("EVIDENCE_SUMMARY_TOO_LONG", f"初始证据摘要不能超过 {MAX_SECTION_CHARS} 字符。")
        if task_id in self._states:
            raise WorkflowError("WORKFLOW_ALREADY_STARTED", "当前任务已有报告流程；继续使用 status，或先 reset。")
        while len(self._states) >= self._max_active_tasks:
            self._states.popitem(last=False)
        state = ReportState(report_goal=goal, initial_evidence_summary=summary)
        self._states[task_id] = state
        return self._status(state, "start")

    def _record_section(self, state: ReportState, section: Any, content: Any, source_refs: Iterable[Any]) -> Dict[str, Any]:
        section_name = str(section or "").strip()
        expected = state.expected_section
        if section_name != expected:
            raise WorkflowError("SECTION_OUT_OF_ORDER", f"当前只能提交章节 {expected}，不能提交 {section_name or '空章节'}。")
        text = self._clean_text(content, "content")
        if len(text) > MAX_SECTION_CHARS:
            raise WorkflowError("SECTION_TOO_LONG", f"章节不能超过 {MAX_SECTION_CHARS} 字符；请压缩结构后重新提交，不要简单截断。")
        state.sections[section_name] = text
        state.sources[section_name] = self._clean_list(source_refs)
        if section_name == "0.3":
            state.capability_matrix = text
        return self._status(state, "record_section", recorded_section=section_name)

    def _request_supplement(self, state: ReportState, queries: Iterable[Any], missing_evidence: Iterable[Any]) -> Dict[str, Any]:
        cleaned_queries = self._clean_list(queries)
        if not cleaned_queries:
            raise WorkflowError("QUERIES_REQUIRED", "补充检索必须提供至少一个针对缺失资料的查询。")
        if state.supplement_rounds >= MAX_SUPPLEMENT_ROUNDS:
            raise WorkflowError("SUPPLEMENT_LIMIT_REACHED", "补充检索最多两轮；请将仍缺失的内容标为资料缺失或待补充。")
        state.supplement_rounds += 1
        state.supplement_history.append(cleaned_queries)
        payload = self._status(state, "request_supplement")
        payload["retrieval"] = {
            "round": state.supplement_rounds,
            "queries": cleaned_queries,
            "missing_evidence": self._clean_list(missing_evidence),
            "instruction": "调用 market-report-rag 的 rag_client.py 批量检索这些问题；检索完成后继续当前 expected_section。",
        }
        return payload

    def _finalize(self, state: ReportState) -> Dict[str, Any]:
        if state.expected_section is not None:
            raise WorkflowError("REPORT_INCOMPLETE", f"报告尚未完成；下一章是 {state.expected_section}。")
        report = "\n\n".join(f"## {section}\n\n{state.sections[section]}" for section in SECTION_ORDER)
        return {
            "ok": True,
            "action": "finalize",
            "complete": True,
            "report": report,
            "sources_by_section": dict(state.sources),
            "supplement_rounds": state.supplement_rounds,
        }

    def _status(self, state: ReportState, action: str, **extra: Any) -> Dict[str, Any]:
        expected = state.expected_section
        payload: Dict[str, Any] = {
            "ok": True,
            "action": action,
            "complete": expected is None,
            "completed_sections": list(state.sections),
            "expected_section": expected,
            "supplement_rounds": state.supplement_rounds,
            "supplement_rounds_remaining": MAX_SUPPLEMENT_ROUNDS - state.supplement_rounds,
        }
        payload.update(extra)
        if expected is not None:
            spec = SECTION_SPECS[expected]
            context = {key: state.sections[key] for key in spec["depends_on"] if key in state.sections}
            payload["next"] = {
                "section": expected,
                "goal": spec["goal"],
                "required_evidence": spec["evidence"],
                "dependency_context": context,
                "capability_matrix": state.capability_matrix if SECTION_ORDER.index(expected) > SECTION_ORDER.index("0.3") else None,
                "initial_evidence_summary": state.initial_evidence_summary,
                "instruction": "仅生成当前章节；资料不足时先 request_supplement，不能跳章或把推断写成内部事实。",
            }
        return payload

    def _require_state(self, task_id: str) -> ReportState:
        state = self._states.get(task_id)
        if state is None:
            raise WorkflowError("WORKFLOW_NOT_STARTED", "当前任务没有报告流程，请先调用 start。")
        return state

    @staticmethod
    def _clean_text(value: Any, field_name: str) -> str:
        text = str(value or "").strip()
        if not text:
            raise WorkflowError("FIELD_REQUIRED", f"{field_name} 不能为空。")
        return text

    @staticmethod
    def _clean_list(values: Iterable[Any]) -> List[str]:
        result: List[str] = []
        for value in values:
            text = str(value).strip()
            if text and text not in result:
                result.append(text)
        return result
