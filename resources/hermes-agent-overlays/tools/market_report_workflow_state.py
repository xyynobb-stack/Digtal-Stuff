"""Process-local state machine for wave-based market-report generation."""

from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence


REQUIRED_RETRIEVAL_COLLECTION = "my_skill_kb"
FORBIDDEN_RETRIEVAL_COLLECTIONS = ("project_embeddings", "project_repo_chunks")

SECTION_ORDER = (
    "1.1", "1.2", "1.3", "2.1", "2.2", "3.1", "3.2",
    "4", "5.1", "5.2", "6.1", "6.2", "7",
)

# 1.1 and 1.2 can be composed together; 1.3 derives their capability matrix.
# Every later unit shares that frozen foundation and is submitted atomically as
# one generation wave, avoiding thirteen model/tool round trips.
GENERATION_WAVES = (
    ("1.1", "1.2"),
    ("1.3",),
    ("2.1", "2.2", "3.1", "3.2", "4", "5.1", "5.2", "6.1", "6.2", "7"),
)

FOUNDATION_SECTIONS = ("1.1", "1.2", "1.3")

SECTION_SPECS: Mapping[str, Dict[str, Any]] = {
    "1.1": {"goal": "历史项目资产表", "evidence": ["A", "B", "C"], "depends_on": []},
    "1.2": {"goal": "人员能力与可用产能表", "evidence": ["D", "E"], "depends_on": []},
    "1.3": {"goal": "有证据支撑的能力矩阵", "evidence": [], "depends_on": ["1.1", "1.2"]},
    "2.1": {"goal": "需求侧市场地图", "evidence": ["H", "销售访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
    "2.2": {"goal": "具名客户优先级", "evidence": ["H", "销售与业务负责人访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
    "3.1": {"goal": "可签约服务目录", "evidence": ["A", "C", "E"], "depends_on": list(FOUNDATION_SECTIONS)},
    "3.2": {"goal": "有证据支撑的差异化", "evidence": ["A", "B", "G", "销售访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
    "4": {"goal": "存量客户扩展机会", "evidence": ["A", "B", "客户访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
    "5.1": {"goal": "丢单与机会缺口清单", "evidence": ["销售访谈", "招标要求"], "depends_on": list(FOUNDATION_SECTIONS)},
    "5.2": {"goal": "人员、工具、流程、渠道的缺口选择", "evidence": ["D", "F", "G", "业务负责人访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
    "6.1": {"goal": "当前市场趋势", "evidence": ["H"], "depends_on": list(FOUNDATION_SECTIONS)},
    "6.2": {"goal": "趋势与能力交叉后的业务启示", "evidence": [], "depends_on": list(FOUNDATION_SECTIONS)},
    "7": {"goal": "决策建议与 90 天行动计划", "evidence": ["业务负责人访谈"], "depends_on": list(FOUNDATION_SECTIONS)},
}

HR_SECTION_ORDER = ("0.1", "0.2", "0.3", "1.1", "1.2", "2.1", "2.2", "3", "4")
HR_GENERATION_WAVES = (
    ("0.1",),
    ("0.2",),
    ("0.3",),
    ("1.1",),
    ("1.2",),
    ("2.1",),
    ("2.2",),
    ("3",),
    ("4",),
)
HR_FOUNDATION = ("0.1", "0.2", "0.3")
HR_SECTION_SPECS: Mapping[str, Dict[str, Any]] = {
    "0.1": {"goal": "按岗位统计人员结构、配比异常和用工形式风险", "evidence": ["B 工时/排班/所在项目", "E 人员技能与背景", "G 岗位职责/SOP"], "depends_on": []},
    "0.2": {"goal": "以实际项目经历判定技能覆盖矩阵和单点能力", "evidence": ["A 项目标注数据", "B 工时/排班/所在项目", "E 人员技能与背景"], "depends_on": []},
    "0.3": {"goal": "按标注品类建立产能与人效基线", "evidence": ["A 项目标注数据", "B 工时/排班", "D 项目交付量与周期"], "depends_on": []},
    "1.1": {"goal": "按品类和项目时间轴测算所需人天与人数", "evidence": ["D 项目交付量与周期", "项目经理访谈", "销售访谈"], "depends_on": ["0.3"]},
    "1.2": {"goal": "按月份和品类计算缺口、冗余及可培训转移能力", "evidence": ["本报告 0.2、0.3、1.1"], "depends_on": ["0.2", "0.3", "1.1"]},
    "2.1": {"goal": "按错误类型归因质量问题并比较新人和老人收敛周期", "evidence": ["C 质检/返工记录", "A 项目标注数据", "F 培训与上手记录"], "depends_on": []},
    "2.2": {"goal": "按品类分析上手周期、培训人天和成长路径", "evidence": ["F 培训与上手记录", "E 人员技能与背景", "G 岗位职责/SOP"], "depends_on": []},
    "3": {"goal": "识别单点依赖、流失、弹性和知识流失风险", "evidence": ["本报告 0.2", "E 人员技能与背景", "H 外部行业资料", "组长访谈"], "depends_on": ["0.2"]},
    "4": {"goal": "用三项经营判断和90天行动表收口", "evidence": ["本报告全篇"], "depends_on": list(HR_SECTION_ORDER[:-1])},
}

FINANCE_SECTION_ORDER = ("0", "1", "2.1", "2.2", "2.3", "3", "4", "5")
FINANCE_GENERATION_WAVES = (
    ("0",),
    ("2.1",),
    ("2.2",),
    ("2.3",),
    ("1",),
    ("3",),
    ("4",),
    ("5",),
)
FINANCE_FOUNDATION = ("0", "1", "2.1", "2.2", "2.3")
FINANCE_SECTION_SPECS: Mapping[str, Dict[str, Any]] = {
    "0": {"goal": "冻结成本纳入项、排除项和关键估算假设", "evidence": ["人天综合成本单一口径；无其他必需资料"], "depends_on": []},
    "1": {"goal": "按客户和标注品类拆分收入结构与集中度", "evidence": ["D 项目交付量与周期", "E 报价区间与计价方式"], "depends_on": ["0"]},
    "2.1": {"goal": "按品类分别计算标注与审核直接人力成本", "evidence": ["A 标注平台数据", "B 工时/排班", "人天综合成本"], "depends_on": ["0"]},
    "2.2": {"goal": "计算返工人天、返工成本及其直接人力成本占比", "evidence": ["C 质检/返工记录", "A 标注平台数据", "B 工时/排班"], "depends_on": ["0"]},
    "2.3": {"goal": "计算工具平台摊销和预标注模型投入产出", "evidence": ["F 工具与平台采购清单"], "depends_on": ["0"]},
    "3": {"goal": "按统一品类生成单位经济模型、毛利排序和盈亏平衡测算", "evidence": ["本报告第1、2章"], "depends_on": list(FINANCE_FOUNDATION)},
    "4": {"goal": "分析客户集中度、单价、低毛利和产能风险", "evidence": ["本报告第1至3章", "G 外部行业资料"], "depends_on": ["1", "2.1", "2.2", "2.3", "3"]},
    "5": {"goal": "用三项经营判断和可验收行动表收口", "evidence": ["本报告全篇"], "depends_on": list(FINANCE_SECTION_ORDER[:-1])},
}

REPORT_DEFINITIONS: Mapping[str, Dict[str, Any]] = {
    "market": {"sections": SECTION_ORDER, "waves": GENERATION_WAVES, "specs": SECTION_SPECS},
    "hr": {"sections": HR_SECTION_ORDER, "waves": HR_GENERATION_WAVES, "specs": HR_SECTION_SPECS},
    "finance": {"sections": FINANCE_SECTION_ORDER, "waves": FINANCE_GENERATION_WAVES, "specs": FINANCE_SECTION_SPECS},
}

MAX_SECTION_CHARS = 6000
MAX_EVIDENCE_SUMMARY_CHARS = 12000
MAX_SUPPLEMENT_ROUNDS = 2
MAX_ACTIVE_TASKS = 128


class WorkflowError(ValueError):
    """A user-correctable workflow protocol violation."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class ReportState:
    report_type: str
    report_goal: str
    retrieval_collection: str
    initial_evidence_summary: str = ""
    sections: Dict[str, str] = field(default_factory=dict)
    sources: Dict[str, List[str]] = field(default_factory=dict)
    supplement_rounds: int = 0
    supplement_history: List[List[str]] = field(default_factory=list)
    capability_matrix: Optional[str] = None

    @property
    def expected_wave(self) -> Optional[Sequence[str]]:
        waves = REPORT_DEFINITIONS[self.report_type]["waves"]
        return next(
            (wave for wave in waves if any(section not in self.sections for section in wave)),
            None,
        )


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
                return self._start(
                    task_id,
                    arguments.get("report_type", "market"),
                    arguments.get("report_goal"),
                    arguments.get("retrieval_collection"),
                    arguments.get("initial_evidence_summary", ""),
                )
            if action == "reset":
                existed = self._states.pop(task_id, None) is not None
                return {"ok": True, "action": action, "reset": existed}

            state = self._require_state(task_id)
            self._states.move_to_end(task_id)
            if action == "status":
                return self._status(state, action)
            if action == "record_wave":
                return self._record_wave(state, arguments.get("sections") or [])
            if action == "record_section":
                return self._record_single_section(
                    state,
                    arguments.get("section"),
                    arguments.get("content"),
                    arguments.get("source_refs") or [],
                )
            if action == "request_supplement":
                return self._request_supplement(
                    state,
                    arguments.get("queries") or [],
                    arguments.get("missing_evidence") or [],
                )
            if action == "finalize":
                return self._finalize(state)
            raise WorkflowError("INVALID_ACTION", f"未知动作：{action}")

    def _start(
        self,
        task_id: str,
        report_type: Any,
        report_goal: Any,
        retrieval_collection: Any,
        initial_evidence_summary: Any,
    ) -> Dict[str, Any]:
        kind = str(report_type or "market").strip().lower()
        if kind not in REPORT_DEFINITIONS:
            raise WorkflowError("INVALID_REPORT_TYPE", f"不支持的报告类型：{kind}")
        goal = self._clean_text(report_goal, "report_goal")
        collection = self._clean_text(retrieval_collection, "retrieval_collection")
        if collection != REQUIRED_RETRIEVAL_COLLECTION:
            raise WorkflowError(
                "COLLECTION_MISMATCH",
                f"报告证据只能来自 {REQUIRED_RETRIEVAL_COLLECTION}，不能使用 {collection}。",
            )
        summary = str(initial_evidence_summary or "").strip()
        if len(summary) > MAX_EVIDENCE_SUMMARY_CHARS:
            raise WorkflowError(
                "EVIDENCE_SUMMARY_TOO_LONG",
                f"初始证据摘要不能超过 {MAX_EVIDENCE_SUMMARY_CHARS} 字符。",
            )
        self._reject_wrong_collection_text(summary, "initial_evidence_summary")
        if task_id in self._states:
            raise WorkflowError("WORKFLOW_ALREADY_STARTED", "当前任务已有报告流程；继续使用 status，或先 reset。")
        while len(self._states) >= self._max_active_tasks:
            self._states.popitem(last=False)
        state = ReportState(
            report_type=kind,
            report_goal=goal,
            retrieval_collection=collection,
            initial_evidence_summary=summary,
        )
        self._states[task_id] = state
        return self._status(state, "start")

    def _record_wave(self, state: ReportState, section_items: Iterable[Any]) -> Dict[str, Any]:
        expected_wave = state.expected_wave
        if expected_wave is None:
            raise WorkflowError("REPORT_ALREADY_COMPLETE", "所有章节已经完成，不能继续提交。")

        prepared: Dict[str, tuple[str, List[str]]] = {}
        for item in section_items:
            if not isinstance(item, Mapping):
                raise WorkflowError("INVALID_SECTION_ITEM", "sections 中的每一项都必须包含 section、content 和 source_refs。")
            section = str(item.get("section") or "").strip()
            if not section or section in prepared:
                raise WorkflowError("INVALID_SECTION_ITEM", f"章节为空或重复：{section or '空章节'}。")
            content = self._clean_text(item.get("content"), f"content[{section}]")
            if len(content) > MAX_SECTION_CHARS:
                raise WorkflowError(
                    "SECTION_TOO_LONG",
                    f"章节 {section} 不能超过 {MAX_SECTION_CHARS} 字符；请压缩结构后重新提交，不要简单截断。",
                )
            self._reject_wrong_collection_text(content, f"content[{section}]")
            prepared[section] = (content, self._clean_list(item.get("source_refs") or []))

        expected = list(expected_wave)
        if set(prepared) != set(expected) or len(prepared) != len(expected):
            raise WorkflowError(
                "WAVE_OUT_OF_ORDER",
                f"当前必须一次提交完整波次 {expected}，实际提交 {list(prepared)}。",
            )

        # Validate the entire wave before mutating state so a bad sibling cannot
        # leave a partially advanced report.
        for section in expected:
            content, source_refs = prepared[section]
            state.sections[section] = content
            state.sources[section] = source_refs
        if state.report_type == "market" and "1.3" in prepared:
            state.capability_matrix = prepared["1.3"][0]
        return self._status(state, "record_wave", recorded_sections=expected)

    def _record_single_section(
        self,
        state: ReportState,
        section: Any,
        content: Any,
        source_refs: Iterable[Any],
    ) -> Dict[str, Any]:
        expected_wave = state.expected_wave
        if expected_wave is None:
            raise WorkflowError("REPORT_ALREADY_COMPLETE", "所有章节已经完成，不能继续提交。")
        if len(expected_wave) != 1:
            raise WorkflowError(
                "WAVE_REQUIRES_BATCH",
                f"当前波次包含 {list(expected_wave)}，必须使用 record_wave 一次提交。",
            )
        return self._record_wave(
            state,
            [{"section": section, "content": content, "source_refs": list(source_refs)}],
        )

    def _request_supplement(
        self,
        state: ReportState,
        queries: Iterable[Any],
        missing_evidence: Iterable[Any],
    ) -> Dict[str, Any]:
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
            "collection": state.retrieval_collection,
            "queries": cleaned_queries,
            "missing_evidence": self._clean_list(missing_evidence),
            "instruction": (
                "只能调用当前报告 Skill 自带的 rag_client.py 批量检索；"
                f"返回 collection 必须为 {REQUIRED_RETRIEVAL_COLLECTION}，否则立即停止。"
            ),
        }
        return payload

    def _finalize(self, state: ReportState) -> Dict[str, Any]:
        expected_wave = state.expected_wave
        if expected_wave is not None:
            raise WorkflowError("REPORT_INCOMPLETE", f"报告尚未完成；下一波是 {list(expected_wave)}。")
        order = REPORT_DEFINITIONS[state.report_type]["sections"]
        report = "\n\n".join(f"## {section}\n\n{state.sections[section]}" for section in order)
        return {
            "ok": True,
            "action": "finalize",
            "complete": True,
            "retrieval_collection": state.retrieval_collection,
            "report_type": state.report_type,
            "report": report,
            "sources_by_section": dict(state.sources),
            "supplement_rounds": state.supplement_rounds,
        }

    def _status(self, state: ReportState, action: str, **extra: Any) -> Dict[str, Any]:
        expected_wave = state.expected_wave
        expected_sections = list(expected_wave or [])
        payload: Dict[str, Any] = {
            "ok": True,
            "action": action,
            "complete": expected_wave is None,
            "retrieval_collection": state.retrieval_collection,
            "report_type": state.report_type,
            "completed_sections": list(state.sections),
            "expected_sections": expected_sections,
            "expected_section": expected_sections[0] if len(expected_sections) == 1 else None,
            "supplement_rounds": state.supplement_rounds,
            "supplement_rounds_remaining": MAX_SUPPLEMENT_ROUNDS - state.supplement_rounds,
        }
        payload.update(extra)
        if expected_wave is not None:
            definition = REPORT_DEFINITIONS[state.report_type]
            dependency_keys: List[str] = []
            section_specs = []
            for section in expected_wave:
                spec = definition["specs"][section]
                section_specs.append(
                    {
                        "section": section,
                        "goal": spec["goal"],
                        "required_evidence": spec["evidence"],
                    }
                )
                for dependency in spec["depends_on"]:
                    if dependency not in dependency_keys:
                        dependency_keys.append(dependency)
            context = {
                key: state.sections[key]
                for key in dependency_keys
                if key in state.sections
            }
            payload["next_wave"] = {
                "wave": definition["waves"].index(expected_wave) + 1,
                "sections": section_specs,
                "dependency_context": context,
                "capability_matrix": state.capability_matrix,
                "initial_evidence_summary": state.initial_evidence_summary,
                "retrieval_collection": state.retrieval_collection,
                "instruction": (
                    "在一个模型轮次中生成本波次全部章节，并用 record_wave 原子提交；"
                    "资料不足时先 request_supplement，不能把推断写成内部事实。"
                ),
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

    @staticmethod
    def _reject_wrong_collection_text(text: str, field_name: str) -> None:
        lowered = text.lower()
        wrong = next(
            (name for name in FORBIDDEN_RETRIEVAL_COLLECTIONS if name.lower() in lowered),
            None,
        )
        if wrong:
            raise WorkflowError(
                "COLLECTION_MISMATCH",
                f"{field_name} 引用了错误集合 {wrong}；报告只能使用 {REQUIRED_RETRIEVAL_COLLECTION} 的证据。",
            )
