import sys
import threading
import unittest
from pathlib import Path


TOOLS_DIR = Path(__file__).parents[2] / "resources" / "hermes-agent-overlays" / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from market_report_workflow_state import (  # noqa: E402
    FINANCE_GENERATION_WAVES,
    FINANCE_SECTION_ORDER,
    GENERATION_WAVES,
    HR_GENERATION_WAVES,
    HR_SECTION_ORDER,
    MarketReportWorkflowStore,
    SECTION_ORDER,
    WorkflowError,
)


def wave_payload(wave, prefix="content"):
    return [
        {
            "section": section,
            "content": f"{prefix}-{section}",
            "source_refs": [f"source-{section}"],
        }
        for section in wave
    ]


class MarketReportWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.store = MarketReportWorkflowStore()
        self.store.execute(
            "task-a",
            "start",
            report_goal="生成市场分析报告",
            retrieval_collection="my_skill_kb",
        )

    def _record_all_waves(self):
        for wave in GENERATION_WAVES:
            self.store.execute(
                "task-a", "record_wave", sections=wave_payload(wave)
            )

    # @lat: [[lat.md/rag-mvp#Tests#Wave orchestration preserves dependencies]]
    def test_enforces_complete_atomic_wave(self):
        with self.assertRaisesRegex(WorkflowError, "一次提交完整波次"):
            self.store.execute(
                "task-a",
                "record_wave",
                sections=wave_payload(("1.1",)),
            )
        self.assertEqual(
            self.store.execute("task-a", "status")["expected_sections"],
            ["1.1", "1.2"],
        )

    def test_freezes_and_carries_capability_matrix(self):
        self.store.execute(
            "task-a", "record_wave", sections=wave_payload(GENERATION_WAVES[0])
        )
        self.store.execute(
            "task-a", "record_wave", sections=wave_payload(GENERATION_WAVES[1])
        )
        status = self.store.execute("task-a", "status")
        self.assertEqual(status["next_wave"]["capability_matrix"], "content-1.3")
        self.assertEqual(
            set(status["next_wave"]["dependency_context"]),
            {"1.1", "1.2", "1.3"},
        )

    def test_limits_supplement_rounds_and_preserves_collection(self):
        for index in range(2):
            result = self.store.execute(
                "task-a", "request_supplement", queries=[f"query-{index}"]
            )
            self.assertEqual(result["retrieval"]["collection"], "my_skill_kb")
        with self.assertRaisesRegex(WorkflowError, "最多两轮"):
            self.store.execute(
                "task-a", "request_supplement", queries=["query-3"]
            )

    def test_finalize_requires_all_waves_and_keeps_order(self):
        with self.assertRaises(WorkflowError):
            self.store.execute("task-a", "finalize")
        self._record_all_waves()
        result = self.store.execute("task-a", "finalize")
        positions = [result["report"].index(f"## {section}\n") for section in SECTION_ORDER]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(result["retrieval_collection"], "my_skill_kb")

    # @lat: [[lat.md/rag-mvp#Tests#Report provenance rejects wrong collections]]
    def test_rejects_wrong_collection_at_start_and_in_report_text(self):
        another = MarketReportWorkflowStore()
        with self.assertRaisesRegex(WorkflowError, "my_skill_kb"):
            another.execute(
                "wrong-collection",
                "start",
                report_goal="报告",
                retrieval_collection="project_embeddings",
            )

        with self.assertRaisesRegex(WorkflowError, "错误集合"):
            self.store.execute(
                "task-a",
                "record_wave",
                sections=[
                    {
                        "section": "1.1",
                        "content": "来自 project_embeddings 的内容",
                    },
                    {"section": "1.2", "content": "人员资料"},
                ],
            )

    def test_tasks_are_isolated(self):
        self.store.execute(
            "task-b",
            "start",
            report_goal="另一份报告",
            retrieval_collection="my_skill_kb",
        )
        self.store.execute(
            "task-a", "record_wave", sections=wave_payload(GENERATION_WAVES[0])
        )
        self.assertEqual(
            self.store.execute("task-b", "status")["expected_sections"],
            ["1.1", "1.2"],
        )

    # @lat: [[lat.md/rag-mvp#Tests#Concurrent wave updates are serialized]]
    def test_concurrent_writes_are_serialized(self):
        barrier = threading.Barrier(3)
        outcomes = []

        def record(prefix):
            barrier.wait()
            try:
                self.store.execute(
                    "task-a",
                    "record_wave",
                    sections=wave_payload(GENERATION_WAVES[0], prefix),
                )
                outcomes.append("ok")
            except WorkflowError as exc:
                outcomes.append(exc.code)

        threads = [threading.Thread(target=record, args=(str(i),)) for i in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(outcomes), ["WAVE_OUT_OF_ORDER", "ok"])

    def test_rejects_oversized_section_instead_of_truncating(self):
        with self.assertRaisesRegex(WorkflowError, "不要简单截断"):
            self.store.execute(
                "task-a",
                "record_wave",
                sections=[
                    {"section": "1.1", "content": "x" * 6001},
                    {"section": "1.2", "content": "valid"},
                ],
            )

    def test_hr_and_finance_use_independent_dependency_wave_contracts(self):
        cases = (
            ("hr-task", "hr", HR_GENERATION_WAVES, HR_SECTION_ORDER),
            ("finance-task", "finance", FINANCE_GENERATION_WAVES, FINANCE_SECTION_ORDER),
        )
        for task_id, report_type, waves, sections in cases:
            store = MarketReportWorkflowStore()
            started = store.execute(
                task_id,
                "start",
                report_type=report_type,
                report_goal=f"生成{report_type}报告",
                retrieval_collection="my_skill_kb",
            )
            self.assertEqual(started["report_type"], report_type)
            self.assertEqual(started["expected_sections"], list(waves[0]))
            for wave in waves:
                store.execute(task_id, "record_wave", sections=wave_payload(wave))
            result = store.execute(task_id, "finalize")
            positions = [result["report"].index(f"## {section}\n") for section in sections]
            self.assertEqual(positions, sorted(positions))


if __name__ == "__main__":
    unittest.main()
