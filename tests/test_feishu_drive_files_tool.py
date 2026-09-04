"""Behavior tests for user-authorized Feishu Drive tools without network access."""

from __future__ import annotations

import base64
import ast
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

# Test canonical source rather than the generated runtime snapshot.
spec = importlib.util.spec_from_file_location("tools.feishu_drive_files_tool", PROJECT_ROOT / "resources/hermes-agent-overlays/tools/feishu_drive_files_tool.py")
drive = importlib.util.module_from_spec(spec)
spec.loader.exec_module(drive)


class UserAuthorizedFeishuDriveTests(unittest.TestCase):
    def test_document_tools_have_literal_top_level_registrations(self) -> None:
        tree = ast.parse(Path(drive.__file__).read_text(encoding="utf-8"))
        names = []
        for statement in tree.body:
            if not isinstance(statement, ast.Expr) or not isinstance(statement.value, ast.Call):
                continue
            call = statement.value
            if isinstance(call.func, ast.Attribute) and call.func.attr == "register":
                names.extend(keyword.value.value for keyword in call.keywords if keyword.arg == "name" and isinstance(keyword.value, ast.Constant))
        for name in ("feishu_docx_read", "feishu_docx_list_blocks", "feishu_docx_append_text", "feishu_docx_update_block"):
            self.assertEqual(names.count(name), 1)

    def test_document_read_accepts_url_and_passes_pagination(self) -> None:
        with patch.object(drive, "_proxy_request", return_value={"content": "正文", "next_offset": 10}) as request:
            result = json.loads(drive._handle_document({"document_id": "https://example.feishu.cn/docx/doc1?from=home", "offset": 2}, "content"))
        self.assertTrue(result["success"])
        self.assertEqual(result["data"]["next_offset"], 10)
        request.assert_called_once_with("GET", "/api/integrations/feishu/drive/documents/doc1/content", query={"offset": 2, "limit": 12000})

    def test_document_targets_and_edits_are_validated_before_network(self) -> None:
        with patch.object(drive, "_proxy_request") as request:
            for document_id in ("https://evil.test/docx/a", "https://a.feishu.cn/wiki/a", "../a", "https://a.feishu.cn/file/a"):
                self.assertIn("error", json.loads(drive._handle_document({"document_id": document_id}, "content")))
            self.assertIn("error", json.loads(drive._handle_document({"document_id": "doc1", "text": "新", "block_id": "b1"}, "update")))
            self.assertIn("error", json.loads(drive._handle_document({"document_id": "doc1", "text": "x" * 2001}, "append")))
            request.assert_not_called()

    def test_document_edits_send_expected_text_and_append_separately(self) -> None:
        with patch.object(drive, "_proxy_request", return_value={}) as request:
            result = json.loads(drive._handle_document({"document_id": "doc1", "block_id": "b1", "expected_text": "旧", "text": "新"}, "update"))
            self.assertTrue(result["success"])
            request.assert_called_once_with("PATCH", "/api/integrations/feishu/drive/documents/doc1/blocks/b1", body={"text": "新", "expected_text": "旧"}, timeout=100)
            request.reset_mock()
            drive._handle_document({"document_id": "doc1", "text": "追加"}, "append")
            request.assert_called_once_with("POST", "/api/integrations/feishu/drive/documents/doc1/append", body={"text": "追加"})

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
