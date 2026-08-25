import sys
import threading
import unittest
from pathlib import Path


TOOLS_DIR = Path(__file__).parents[2] / "resources" / "hermes-agent-overlays" / "tools"
sys.path.insert(0, str(TOOLS_DIR))

from market_report_workflow_state import (  # noqa: E402
    MarketReportWorkflowStore,
    SECTION_ORDER,
    WorkflowError,
)


class MarketReportWorkflowTests(unittest.TestCase):
    def setUp(self):
        self.store = MarketReportWorkflowStore()
        self.store.execute("task-a", "start", report_goal="生成市场分析报告")

    def _record_through(self, final_section):
        for section in SECTION_ORDER:
            self.store.execute("task-a", "record_section", section=section, content=f"content-{section}")
            if section == final_section:
                break

    def test_enforces_section_order(self):
        with self.assertRaisesRegex(WorkflowError, "只能提交章节 0.1"):
            self.store.execute("task-a", "record_section", section="0.2", content="wrong")

    def test_freezes_and_carries_capability_matrix(self):
        self._record_through("0.3")
        status = self.store.execute("task-a", "status")
        self.assertEqual(status["next"]["capability_matrix"], "content-0.3")
        with self.assertRaises(WorkflowError):
            self.store.execute("task-a", "record_section", section="0.3", content="changed")

    def test_limits_supplement_rounds(self):
        for index in range(2):
            self.store.execute("task-a", "request_supplement", queries=[f"query-{index}"])
        with self.assertRaisesRegex(WorkflowError, "最多两轮"):
            self.store.execute("task-a", "request_supplement", queries=["query-3"])

    def test_finalize_requires_all_sections_and_keeps_order(self):
        with self.assertRaises(WorkflowError):
            self.store.execute("task-a", "finalize")
        self._record_through("6")
        result = self.store.execute("task-a", "finalize")
        positions = [result["report"].index(f"## {section}\n") for section in SECTION_ORDER]
        self.assertEqual(positions, sorted(positions))

    def test_tasks_are_isolated(self):
        self.store.execute("task-b", "start", report_goal="另一份报告")
        self.store.execute("task-a", "record_section", section="0.1", content="A")
        self.assertEqual(self.store.execute("task-b", "status")["expected_section"], "0.1")

    def test_concurrent_writes_are_serialized(self):
        barrier = threading.Barrier(3)
        outcomes = []

        def record(content):
            barrier.wait()
            try:
                self.store.execute("task-a", "record_section", section="0.1", content=content)
                outcomes.append("ok")
            except WorkflowError as exc:
                outcomes.append(exc.code)

        threads = [threading.Thread(target=record, args=(str(i),)) for i in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(outcomes), ["SECTION_OUT_OF_ORDER", "ok"])

    def test_rejects_oversized_section_instead_of_truncating(self):
        with self.assertRaisesRegex(WorkflowError, "不要简单截断"):
            self.store.execute("task-a", "record_section", section="0.1", content="x" * 6001)


if __name__ == "__main__":
    unittest.main()
