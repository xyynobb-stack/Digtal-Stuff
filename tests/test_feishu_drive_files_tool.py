"""Behavior tests for user-authorized Feishu Drive tools without network access."""

from __future__ import annotations

import base64
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
AGENT_ROOT = PROJECT_ROOT / "build" / "offline-runtime" / "hermes-agent"
sys.path.insert(0, str(AGENT_ROOT))

drive = importlib.import_module("tools.feishu_drive_files_tool")


class UserAuthorizedFeishuDriveTests(unittest.TestCase):
    # @lat: [[feishu-drive#Runtime delivery#Built-in discovery]]
    def test_module_is_discovered_and_tools_are_eager(self) -> None:
        from tools.registry import _module_registers_tools
        from tools.tool_search import is_deferrable_tool_name

        self.assertTrue(_module_registers_tools(Path(drive.__file__)))
        for name in (
            "feishu_drive_list_files",
            "feishu_drive_search_files",
            "feishu_drive_create_folder",
            "feishu_drive_upload_file",
            "feishu_drive_delete_file",
        ):
            self.assertFalse(is_deferrable_tool_name(name))

    # @lat: [[feishu-drive#Connection boundary]]
    def test_tool_is_available_only_after_profile_connection(self) -> None:
        with patch.object(drive, "_secret", return_value=""):
            self.assertFalse(drive._check_feishu_drive_files())
        with patch.object(
            drive,
            "_service_config",
            return_value=("http://oauth.test", "connection-token"),
        ):
            self.assertTrue(drive._check_feishu_drive_files())

    # @lat: [[feishu-drive#Personal Drive operations]]
    def test_list_defaults_to_the_connected_users_root(self) -> None:
        with (
            patch.object(drive, "_root", return_value={"token": "user-root"}),
            patch.object(
                drive,
                "_list_page",
                return_value={"files": [{"token": "file-1", "name": "报告"}]},
            ) as list_page,
        ):
            result = json.loads(drive._handle_list_files({}))

        self.assertTrue(result["success"])
        self.assertEqual(result["user_root"]["token"], "user-root")
        self.assertEqual(result["files"][0]["token"], "file-1")
        list_page.assert_called_once_with("user-root", "", 100)

    def test_create_folder_defaults_to_the_connected_users_root(self) -> None:
        with (
            patch.object(drive, "_root", return_value={"token": "user-root"}),
            patch.object(
                drive,
                "_proxy_request",
                return_value={"token": "folder-1", "name": "项目资料"},
            ) as request,
        ):
            result = json.loads(drive._handle_create_folder({"name": "项目资料"}))

        self.assertTrue(result["success"])
        request.assert_called_once_with(
            "POST",
            "/api/integrations/feishu/drive/folders",
            body={"name": "项目资料", "folder_token": "user-root"},
        )

    # @lat: [[feishu-drive#Local upload safety]]
    def test_upload_sends_local_file_through_the_oauth_proxy(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            local_file = Path(temp_dir) / "report.txt"
            local_file.write_bytes(b"ready")
            with (
                patch.object(drive, "_resolve_upload_path", return_value=local_file),
                patch.object(drive, "_root", return_value={"token": "user-root"}),
                patch.object(
                    drive,
                    "_proxy_request",
                    return_value={"file_token": "uploaded"},
                ) as request,
            ):
                result = json.loads(
                    drive._handle_upload_file(
                        {"local_path": "report.txt", "parent_token": "folder-1"},
                        task_id="task-123",
                    )
                )

        self.assertTrue(result["success"])
        call = request.call_args
        self.assertEqual(call.args[:2], ("POST", "/api/integrations/feishu/drive/files/upload"))
        self.assertEqual(call.kwargs["body"]["parent_node"], "folder-1")
        self.assertEqual(base64.b64decode(call.kwargs["body"]["content_base64"]), b"ready")

    # @lat: [[feishu-drive#Destructive operation guard]]
    def test_delete_requires_exact_confirmation_and_rejects_folders(self) -> None:
        missing = json.loads(
            drive._handle_delete_file({"file_token": "file-1", "confirmation": "yes"})
        )
        self.assertIn("confirmation", missing["error"])

        with patch.object(drive, "_proxy_request") as request:
            folder = json.loads(
                drive._handle_delete_file(
                    {
                        "file_token": "folder-1",
                        "file_type": "folder",
                        "confirmation": "DELETE:folder-1",
                    }
                )
            )
        self.assertIn("Folder deletion", folder["error"])
        request.assert_not_called()

        with patch.object(drive, "_proxy_request", return_value={"ok": True}) as request:
            deleted = json.loads(
                drive._handle_delete_file(
                    {
                        "file_token": "file-1",
                        "file_type": "file",
                        "confirmation": "DELETE:file-1",
                    }
                )
            )
        self.assertTrue(deleted["ok"])
        request.assert_called_once_with(
            "DELETE",
            "/api/integrations/feishu/drive/files/file-1",
            query={"type": "file"},
        )

    def test_search_walks_the_connected_users_drive(self) -> None:
        listings = {
            "user-root": [
                {"token": "folder-a", "type": "folder", "name": "资料"},
                {"token": "file-a", "type": "file", "name": "月度报告.pdf"},
            ],
            "folder-a": [
                {"token": "file-b", "type": "file", "name": "报告附件.xlsx"}
            ],
        }
        with (
            patch.object(drive, "_root", return_value={"token": "user-root"}),
            patch.object(drive, "_list_all", side_effect=lambda token: listings[token]),
        ):
            result = json.loads(drive._handle_search_files({"query": "报告"}))

        self.assertEqual([item["token"] for item in result["matches"]], ["file-a", "file-b"])


if __name__ == "__main__":
    unittest.main()
