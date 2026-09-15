"""Behavior tests for scheduled Feishu Drive delivery without network access."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "build" / "offline-runtime" / "hermes-agent"
sys.path.insert(0, str(AGENT_ROOT))

spec = importlib.util.spec_from_file_location(
    "cron_feishu_drive_delivery_under_test",
    PROJECT_ROOT
    / "resources"
    / "hermes-agent-overlays"
    / "tools"
    / "cron_feishu_drive_delivery.py",
)
delivery = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(delivery)


class ScheduledFeishuDriveDeliveryTests(unittest.TestCase):
    # @lat: [[feishu-drive#Runtime delivery#Scheduled Drive delivery#Destination selection]]
    def test_accepts_personal_root_and_explicit_folder_targets(self) -> None:
        self.assertTrue(delivery.is_feishu_drive_delivery({"deliver": "feishu"}))
        self.assertIsNone(delivery.delivery_folder_token({"deliver": "feishu"}))
        self.assertEqual(
            delivery.delivery_folder_token({"deliver": "feishu:folder_token"}),
            "folder_token",
        )
        self.assertFalse(delivery.is_feishu_drive_delivery({"deliver": "local"}))

    # @lat: [[feishu-drive#Runtime delivery#Scheduled Drive delivery#Isolated run output]]
    def test_prepares_an_isolated_output_directory_and_prompt(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            profile_home = Path(temporary)
            job = {"id": "job/one", "deliver": "feishu:folder_token"}
            with patch.object(delivery, "get_hermes_home", return_value=profile_home):
                first = delivery.prepare_run_output_dir(job)
                second = delivery.prepare_run_output_dir(job)

            self.assertEqual(first, second)
            self.assertTrue(Path(first).is_dir())
            self.assertTrue(Path(first).is_relative_to(profile_home / "cron" / "feishu-drive"))
            prompt = delivery.build_delivery_prompt(job)
            self.assertIn("folder_token", prompt)
            self.assertIn("最终成品", prompt)

    # @lat: [[feishu-drive#Runtime delivery#Scheduled Drive delivery#Artifact upload and fallback]]
    def test_uploads_artifacts_and_records_a_manifest(self) -> None:
        from tools import feishu_drive_files_tool as drive

        with tempfile.TemporaryDirectory() as temporary:
            profile_home = Path(temporary)
            job = {"id": "job-one", "name": "月报", "deliver": "feishu:folder_token"}
            with patch.object(delivery, "get_hermes_home", return_value=profile_home):
                output_dir = Path(delivery.prepare_run_output_dir(job))
                artifact = output_dir / "月报.docx"
                artifact.write_bytes(b"document")
                with (
                    patch.object(
                        drive,
                        "_handle_upload_file",
                        return_value=json.dumps(
                            {
                                "success": True,
                                "parent_token": "folder_token",
                                "file": {"file_token": "uploaded"},
                            }
                        ),
                    ) as upload,
                    patch(
                        "agent.secret_scope.build_profile_secret_scope",
                        return_value={},
                    ),
                ):
                    error = delivery.deliver_job_output(job, "完成")

            self.assertIsNone(error)
            upload.assert_called_once()
            arguments = upload.call_args.args[0]
            self.assertEqual(arguments["local_path"], str(artifact))
            self.assertEqual(arguments["parent_token"], "folder_token")
            manifest = json.loads(
                (output_dir / delivery.DELIVERY_MANIFEST).read_text(encoding="utf-8")
            )
            self.assertEqual(manifest["uploaded"][0]["file"]["file_token"], "uploaded")
            self.assertEqual(manifest["errors"], [])

    def test_uploads_a_markdown_result_when_no_artifact_was_generated(self) -> None:
        from tools import feishu_drive_files_tool as drive

        with tempfile.TemporaryDirectory() as temporary:
            profile_home = Path(temporary)
            job = {"id": "job-two", "name": "结果", "deliver": "feishu"}
            with (
                patch.object(delivery, "get_hermes_home", return_value=profile_home),
                patch.object(
                    drive,
                    "_handle_upload_file",
                    return_value=json.dumps(
                        {
                            "success": True,
                            "parent_token": "root",
                            "file": {"file_token": "summary"},
                        }
                    ),
                ) as upload,
                patch("agent.secret_scope.build_profile_secret_scope", return_value={}),
            ):
                error = delivery.deliver_job_output(job, "计划任务正文")

            self.assertIsNone(error)
            arguments = upload.call_args.args[0]
            self.assertNotIn("parent_token", arguments)
            self.assertTrue(arguments["file_name"].endswith(".md"))
            self.assertEqual(
                Path(arguments["local_path"]).read_text(encoding="utf-8"),
                "计划任务正文\n",
            )


if __name__ == "__main__":
    unittest.main()
