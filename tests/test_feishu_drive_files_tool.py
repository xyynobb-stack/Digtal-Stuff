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
        for name in (
            "feishu_docx_read", "feishu_docx_list_blocks",
            "feishu_docx_append_text", "feishu_docx_update_block",
            "feishu_sheet_get_metadata", "feishu_sheet_read_range",
            "feishu_sheet_write_range", "feishu_sheet_append_rows",
            "feishu_sheet_clear_range",
            "feishu_bitable_list_fields", "feishu_bitable_list_records",
            "feishu_bitable_update_record",
            "feishu_markdown_read", "feishu_pdf_read",
            "feishu_drive_list_locations",
        ):
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

    def test_list_accepts_a_shared_folder_link(self) -> None:
        with (
            patch.object(drive, "_list_page", return_value={"files": []}) as list_page,
            patch.object(drive, "_register_shared_folder") as register,
        ):
            result = json.loads(drive._handle_list_files({
                "folder_token": "https://tenant.feishu.cn/drive/folder/shared-1?from=share",
            }))
        self.assertTrue(result["success"])
        self.assertEqual(result["scope"], "selected_folder")
        self.assertEqual(result["listed_folder_token"], "shared-1")
        self.assertNotIn("user_root", result)
        list_page.assert_called_once_with("shared-1", "", 100)
        register.assert_called_once_with(
            "shared-1",
            "https://tenant.feishu.cn/drive/folder/shared-1?from=share",
        )

    def test_shared_folder_registry_is_profile_scoped_and_discoverable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(
                drive, "_shared_folder_directory", return_value=Path(temp_dir)
            ):
                drive._register_shared_folder(
                    "shared-1",
                    "https://tenant.feishu.cn/drive/folder/shared-1",
                )
                stored = drive._registered_shared_folders()
                with patch.object(
                    drive, "_root", return_value={"token": "user-root"}
                ):
                    result = json.loads(drive._handle_list_locations({}))
        self.assertEqual(stored[0]["folder_token"], "shared-1")
        self.assertEqual(result["registered_shared_count"], 1)
        self.assertEqual(
            [location["scope"] for location in result["locations"]],
            ["personal_root", "registered_shared_folder"],
        )

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

    def test_markdown_read_downloads_utf8_content_and_paginates(self) -> None:
        with patch.object(
            drive,
            "_proxy_request",
            return_value={
                "content_base64": base64.b64encode("# 标题\n正文".encode()).decode(),
                "content_type": "text/markdown",
                "size": len("# 标题\n正文".encode()),
            },
        ) as request:
            result = json.loads(
                drive._handle_markdown_read(
                    {
                        "file_token": "https://tenant.feishu.cn/file/file-1",
                        "offset": 2,
                        "limit": 3,
                    }
                )
            )
        self.assertTrue(result["success"])
        self.assertEqual(result["content"], "标题\n")
        self.assertEqual(result["next_offset"], 5)
        request.assert_called_once_with(
            "GET",
            "/api/integrations/feishu/drive/files/file-1/content",
            timeout=60,
        )

    def test_markdown_read_rejects_non_utf8_and_untrusted_urls(self) -> None:
        with patch.object(
            drive,
            "_proxy_request",
            return_value={
                "content_base64": base64.b64encode(b"\xff").decode(),
                "size": 1,
            },
        ):
            invalid_encoding = json.loads(
                drive._handle_markdown_read({"file_token": "file-1"})
            )
        self.assertIn("UTF-8", invalid_encoding["error"])
        with patch.object(drive, "_proxy_request") as request:
            invalid_url = json.loads(
                drive._handle_markdown_read(
                    {"file_token": "https://evil.test/file/file-1"}
                )
            )
        self.assertIn("error", invalid_url)
        request.assert_not_called()

    def test_pdf_read_returns_bounded_text_and_next_page(self) -> None:
        with (
            patch.object(
                drive,
                "_download_file_bytes",
                return_value=("pdf-1", b"pdf", "application/pdf"),
            ),
            patch.object(
                drive,
                "_extract_pdf_text",
                return_value=(30, 20, "--- 第 1 页 ---\n正文内容"),
            ) as extract,
        ):
            result = json.loads(
                drive._handle_pdf_read(
                    {"file_token": "pdf-1", "offset": 0, "limit": 8}
                )
            )
        self.assertTrue(result["success"])
        self.assertEqual(result["total_pages"], 30)
        self.assertEqual(result["next_page"], 21)
        self.assertEqual(result["next_offset"], 8)
        extract.assert_called_once_with(b"pdf", 1, None)

    def test_pdf_read_explains_when_selected_pages_have_no_text(self) -> None:
        with (
            patch.object(
                drive,
                "_download_file_bytes",
                return_value=("pdf-1", b"pdf", "application/pdf"),
            ),
            patch.object(
                drive,
                "_extract_pdf_text",
                return_value=(1, 1, "--- 第 1 页 ---"),
            ),
        ):
            result = json.loads(drive._handle_pdf_read({"file_token": "pdf-1"}))
        self.assertIn("OCR", result["error"])

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
            patch.object(drive, "_list_all", side_effect=lambda token: listings[token]),
            patch.object(drive, "_register_shared_folder"),
        ):
            result = json.loads(
                drive._handle_search_files(
                    {"query": "报告", "folder_token": "user-root"}
                )
            )

        self.assertEqual([item["token"] for item in result["matches"]], ["file-a", "file-b"])

    def test_search_without_folder_uses_all_accessible_documents(self) -> None:
        with (
            patch.object(
                drive,
                "_proxy_request",
                return_value={
                    "docs_entities": [{"docs_token": "shared-doc", "title": "共享报告"}],
                    "has_more": True,
                },
            ) as request,
            patch.object(drive, "_root", side_effect=drive.FeishuDriveError("offline")),
        ):
            result = json.loads(drive._handle_search_files({"query": "报告", "limit": 20}))
        self.assertTrue(result["success"])
        self.assertEqual(result["scope"], "all_accessible_documents")
        self.assertEqual(result["matches"][0]["docs_token"], "shared-doc")
        self.assertEqual(result["matches"][0]["token"], "shared-doc")
        self.assertEqual(result["matches"][0]["name"], "共享报告")
        self.assertEqual(result["next_offset"], 1)
        request.assert_called_once_with(
            "POST",
            "/api/integrations/feishu/drive/search",
            body={"query": "报告", "count": 20, "offset": 0, "docs_types": None},
        )

    def test_global_search_prefers_current_users_personal_file(self) -> None:
        search_data = {
            "docs_entities": [
                {
                    "docs_token": "other-copy",
                    "title": "任务跟进看板",
                    "owned_by_current_user": False,
                },
                {
                    "docs_token": "my-copy",
                    "title": "任务跟进看板",
                    "owned_by_current_user": True,
                },
            ]
        }
        with (
            patch.object(drive, "_proxy_request", return_value=search_data),
            patch.object(drive, "_root", return_value={"token": "user-root"}),
            patch.object(
                drive,
                "_list_all",
                return_value=[
                    {"token": "my-copy", "type": "sheet"},
                    {"token": "other-personal", "type": "sheet"},
                ],
            ),
        ):
            result = json.loads(
                drive._handle_search_files({"query": "任务跟进看板"})
            )
        self.assertEqual(result["preferred_match"]["token"], "my-copy")
        self.assertTrue(result["preferred_match"]["owned_by_current_user"])
        self.assertTrue(result["preferred_match"]["in_personal_files"])
        self.assertEqual(result["matches"][0]["token"], "my-copy")
        self.assertEqual(
            [item["token"] for item in result["alternative_matches"]],
            ["other-copy"],
        )

    def test_sheet_links_and_range_actions_are_validated(self) -> None:
        metadata = {"sheets": [{"sheetId": "sid-data", "title": "数据"}]}
        with patch.object(
            drive,
            "_proxy_request",
            side_effect=[metadata, {"valueRange": {"values": [[1]]}}],
        ) as request:
            result = json.loads(drive._handle_sheet({
                "spreadsheet_token": "https://tenant.feishu.cn/sheets/sheet-1?sheet=abc",
                "range": "数据!A1:B2",
            }, "read"))
        self.assertTrue(result["success"])
        self.assertEqual(result["resolved_range"], "sid-data!A1:B2")
        self.assertEqual(
            request.call_args_list[1].args,
            ("GET", "/api/integrations/feishu/drive/spreadsheets/sheet-1/values"),
        )
        self.assertEqual(request.call_args_list[1].kwargs["query"], {"range": "sid-data!A1:B2"})

        with patch.object(drive, "_proxy_request") as request:
            invalid = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1", "range": "数据!A1", "values": [{"bad": True}],
            }, "write"))
        self.assertIn("数组", invalid["error"])
        request.assert_not_called()

    def test_sheet_write_append_and_clear_use_distinct_proxy_actions(self) -> None:
        metadata = {"sheets": [{"sheetId": "sid-data", "title": "数据"}]}

        def respond(method: str, path: str, **kwargs: object) -> dict:
            return metadata if path.endswith("/meta") else {"ok": True}

        with patch.object(drive, "_proxy_request", side_effect=respond) as request:
            written = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1", "range": "数据!A1:B1", "values": [["名称", 1]],
            }, "write"))
            self.assertTrue(written["success"])
            request.assert_called_with(
                "POST",
                "/api/integrations/feishu/drive/spreadsheets/sheet-1/values",
                body={"range": "sid-data!A1:B1", "values": [["名称", 1]]},
                timeout=60,
            )
            request.reset_mock()
            drive._handle_sheet({
                "spreadsheet_token": "sheet-1", "range": "数据!A:B", "values": [["新增", 2]],
            }, "append")
            request.assert_called_with(
                "POST",
                "/api/integrations/feishu/drive/spreadsheets/sheet-1/append",
                body={"range": "sid-data!A:B", "values": [["新增", 2]]},
                timeout=60,
            )
            request.reset_mock()
            denied = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1", "range": "数据!A2:B2", "confirmation": "yes",
            }, "clear"))
            self.assertIn("confirmation", denied["error"])
            request.assert_not_called()
            cleared = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1", "range": "数据!A2:B2",
                "confirmation": "CLEAR:sheet-1:数据!A2:B2",
            }, "clear"))
            self.assertTrue(cleared["success"])
            request.assert_called_with(
                "POST",
                "/api/integrations/feishu/drive/spreadsheets/sheet-1/clear",
                body={"range": "sid-data!A2:B2"},
            )

    def test_sheet_range_accepts_sheet_id_and_reports_available_sheets(self) -> None:
        metadata = {"sheets": [{"sheetId": "sid-data", "title": "数据"}]}
        with patch.object(drive, "_proxy_request", return_value=metadata):
            requested, resolved, sheet_id, title, block_type, block_token = drive._resolve_sheet_range(
                "/sheet", "sid-data!A1:B2"
            )
            missing = json.loads(
                drive._handle_sheet(
                    {"spreadsheet_token": "sheet-1", "range": "不存在!A1"},
                    "read",
                )
            )
        self.assertEqual(requested, "sid-data!A1:B2")
        self.assertEqual(resolved, "sid-data!A1:B2")
        self.assertEqual((sheet_id, title), ("sid-data", "数据"))
        self.assertEqual((block_type, block_token), ("", ""))
        self.assertIn("数据 (sid-data)", missing["error"])

    def test_single_cell_write_expands_range_for_feishu(self) -> None:
        metadata = {"sheets": [{"sheetId": "sid-data", "title": "数据"}]}

        def respond(method: str, path: str, **kwargs: object) -> dict:
            return metadata if path.endswith("/meta") else {"ok": True}

        with patch.object(drive, "_proxy_request", side_effect=respond) as request:
            result = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1",
                "range": "数据!C18",
                "values": [["备忘录"]],
            }, "write"))
        self.assertTrue(result["success"])
        self.assertEqual(result["requested_range"], "数据!C18")
        self.assertEqual(result["resolved_range"], "sid-data!C18:C18")
        request.assert_called_with(
            "POST",
            "/api/integrations/feishu/drive/spreadsheets/sheet-1/values",
            body={"range": "sid-data!C18:C18", "values": [["备忘录"]]},
            timeout=60,
        )

    def test_embedded_bitable_sheet_reads_records_instead_of_cell_range(self) -> None:
        metadata = {"sheets": [{
            "sheetId": "calendar",
            "title": "日历",
            "blockInfo": {
                "blockType": "BITABLE_BLOCK",
                "blockToken": "base-token_tblCalendar",
            },
        }]}
        with patch.object(
            drive,
            "_proxy_request",
            side_effect=[metadata, {"items": [{"record_id": "rec-1"}]}],
        ) as request:
            result = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1",
                "range": "日历!A1:E20",
                "page_size": 50,
            }, "read"))
        self.assertTrue(result["success"])
        self.assertEqual(result["content_type"], "embedded_bitable")
        self.assertEqual(result["data"]["items"][0]["record_id"], "rec-1")
        request.assert_called_with(
            "GET",
            "/api/integrations/feishu/drive/bitables/base-token/tables/tblCalendar/records",
            query={"page_size": 50, "page_token": None},
        )

    def test_embedded_bitable_sheet_rejects_sheet_cell_writes(self) -> None:
        metadata = {"sheets": [{
            "sheetId": "calendar",
            "title": "日历",
            "blockInfo": {
                "blockType": "BITABLE_BLOCK",
                "blockToken": "base-token_tblCalendar",
            },
        }]}
        with patch.object(drive, "_proxy_request", return_value=metadata) as request:
            result = json.loads(drive._handle_sheet({
                "spreadsheet_token": "sheet-1",
                "range": "日历!A1",
                "values": [["错误写法"]],
            }, "write"))
        self.assertIn("嵌入式多维表格", result["error"])
        self.assertEqual(request.call_count, 1)

    def test_bitable_fields_and_records_resolve_embedded_sheet(self) -> None:
        metadata = {"sheets": [{
            "sheetId": "board",
            "title": "任务跟进看板",
            "blockInfo": {
                "blockType": "BITABLE_BLOCK",
                "blockToken": "base-token_tblTasks",
            },
        }]}
        with patch.object(
            drive,
            "_proxy_request",
            side_effect=[
                metadata,
                {"items": [{"field_id": "fld-1", "field_name": "任务"}]},
                metadata,
                {"items": [{"record_id": "rec-1", "fields": {"任务": "拜访"}}]},
            ],
        ) as request:
            fields = json.loads(drive._handle_bitable({
                "spreadsheet_token": "sheet-1",
                "sheet": "任务跟进看板",
            }, "fields"))
            records = json.loads(drive._handle_bitable({
                "spreadsheet_token": "sheet-1",
                "sheet": "board",
                "page_size": 50,
            }, "records"))
        self.assertTrue(fields["success"])
        self.assertEqual(fields["data"]["items"][0]["field_id"], "fld-1")
        self.assertEqual(records["data"]["items"][0]["record_id"], "rec-1")
        self.assertEqual(
            request.call_args_list[1].args[1],
            "/api/integrations/feishu/drive/bitables/base-token/tables/tblTasks/fields",
        )
        self.assertEqual(
            request.call_args_list[3].args[1],
            "/api/integrations/feishu/drive/bitables/base-token/tables/tblTasks/records",
        )

    def test_bitable_update_record_sends_only_supplied_fields(self) -> None:
        metadata = {"sheets": [{
            "sheetId": "board",
            "title": "任务跟进看板",
            "blockInfo": {
                "blockType": "BITABLE_BLOCK",
                "blockToken": "base-token_tblTasks",
            },
        }]}
        with patch.object(
            drive,
            "_proxy_request",
            side_effect=[metadata, {"record": {"record_id": "rec-1"}}],
        ) as request:
            result = json.loads(drive._handle_bitable({
                "spreadsheet_token": "sheet-1",
                "sheet": "board",
                "record_id": "rec-1",
                "fields": {"状态": "完成"},
            }, "update"))
        self.assertTrue(result["success"])
        request.assert_called_with(
            "PUT",
            "/api/integrations/feishu/drive/bitables/base-token/tables/tblTasks/records/rec-1",
            body={"fields": {"状态": "完成"}},
            timeout=60,
        )


if __name__ == "__main__":
    unittest.main()
