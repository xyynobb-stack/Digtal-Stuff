"""User-authorized Feishu Drive operations proxied through JingYuAI.

The desktop profile stores only a revocable JingYuAI connection token. Feishu
app credentials and user access/refresh tokens remain on the OAuth server and
are never accepted as model-visible tool arguments.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path, PurePosixPath
from typing import Any

from tools.registry import registry, tool_error, tool_result


DEFAULT_SERVICE_URL = "http://183.230.226.81:5082"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_TRAVERSED_FOLDERS = 1000


class FeishuDriveError(RuntimeError):
    """A sanitized OAuth proxy or Feishu Drive error."""


def _secret(name: str) -> str:
    from agent.secret_scope import get_secret

    return str(get_secret(name, "") or "").strip()


def _service_config() -> tuple[str, str]:
    token = _secret("FEISHU_OAUTH_CONNECTION_TOKEN")
    if not token:
        raise FeishuDriveError(
            "Feishu is not connected; use Connect Feishu in Digital Employee first"
        )
    base_url = _secret("FEISHU_OAUTH_BASE_URL") or DEFAULT_SERVICE_URL
    parsed = urllib.parse.urlsplit(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise FeishuDriveError("The Feishu OAuth service URL is invalid")
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise FeishuDriveError("The Feishu OAuth service URL is invalid")
    return base_url.rstrip("/"), token


def _check_feishu_drive_files() -> bool:
    try:
        _service_config()
        return True
    except Exception:
        return False


def _proxy_request(
    method: str,
    path: str,
    *,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout: int = 35,
) -> dict[str, Any]:
    base_url, token = _service_config()
    url = f"{base_url}{path}"
    if query:
        values = {
            key: str(value)
            for key, value in query.items()
            if value is not None and str(value) != ""
        }
        if values:
            url = f"{url}?{urllib.parse.urlencode(values)}"
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(65536).decode("utf-8", errors="replace"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            payload = {}
        code = str(payload.get("error") or f"HTTP {exc.code}")
        if exc.code == 401:
            raise FeishuDriveError(
                "Feishu authorization expired; reconnect Feishu in Digital Employee"
            ) from None
        raise FeishuDriveError(f"Feishu Drive request failed: {code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise FeishuDriveError("The Feishu Drive service is unavailable") from None
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise FeishuDriveError("The Feishu Drive service returned invalid data") from None
    if not isinstance(payload, dict):
        raise FeishuDriveError("The Feishu Drive service returned invalid data")
    return payload


def _item_token(item: dict[str, Any]) -> str:
    return str(item.get("token") or item.get("file_token") or "").strip()


def _item_type(item: dict[str, Any]) -> str:
    return str(item.get("type") or item.get("file_type") or "").strip().lower()


def _safe_name(name: Any) -> str:
    value = str(name or "").strip()
    if not value or value in {".", ".."} or "/" in value or "\\" in value:
        raise FeishuDriveError("name must be one non-empty file or folder name")
    return value


def _root() -> dict[str, Any]:
    data = _proxy_request("GET", "/api/integrations/feishu/drive/root")
    token = str(data.get("token") or data.get("folder_token") or "").strip()
    if not token:
        raise FeishuDriveError("Feishu did not return the user's root folder")
    return {**data, "token": token, "type": "folder"}


def _list_page(
    folder_token: str, page_token: str = "", page_size: int = 100
) -> dict[str, Any]:
    return _proxy_request(
        "GET",
        "/api/integrations/feishu/drive/files",
        query={
            "folder_token": folder_token,
            "page_token": page_token,
            "page_size": page_size,
        },
    )


def _list_all(folder_token: str) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    page_token = ""
    for _ in range(100):
        data = _list_page(folder_token, page_token)
        files.extend(
            item for item in (data.get("files") or []) if isinstance(item, dict)
        )
        if not data.get("has_more"):
            return files
        next_token = str(data.get("next_page_token") or "")
        if not next_token or next_token == page_token:
            raise FeishuDriveError("Feishu returned an invalid pagination token")
        page_token = next_token
    raise FeishuDriveError("Feishu pagination exceeded the safety limit")


def _handle_list_files(args: dict, **kwargs: Any) -> str:
    try:
        root = _root()
        folder_token = str(args.get("folder_token") or root["token"]).strip()
        page_size = max(1, min(int(args.get("page_size", 100)), 200))
        data = _list_page(
            folder_token,
            str(args.get("page_token") or "").strip(),
            page_size,
        )
        files = [item for item in (data.get("files") or []) if isinstance(item, dict)]
        return tool_result(
            success=True,
            user_root=root,
            folder_token=folder_token,
            files=files,
            count=len(files),
            has_more=bool(data.get("has_more")),
            next_page_token=data.get("next_page_token"),
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_search_files(args: dict, **kwargs: Any) -> str:
    try:
        query = str(args.get("query") or "").strip().casefold()
        if not query:
            raise FeishuDriveError("query is required")
        limit = max(1, min(int(args.get("limit", 50)), 200))
        root = _root()
        start_token = str(args.get("folder_token") or root["token"]).strip()
        queue: deque[str] = deque([start_token])
        visited = {start_token}
        matches: list[dict[str, Any]] = []
        while queue and len(matches) < limit:
            current = queue.popleft()
            for item in _list_all(current):
                token = _item_token(item)
                if query in str(item.get("name") or "").casefold():
                    matches.append({**item, "parent_token": current})
                    if len(matches) >= limit:
                        break
                if _item_type(item) == "folder" and token and token not in visited:
                    visited.add(token)
                    if len(visited) > MAX_TRAVERSED_FOLDERS:
                        raise FeishuDriveError(
                            "Drive folder traversal exceeded the safety limit"
                        )
                    queue.append(token)
        return tool_result(
            success=True,
            user_root=root,
            query=args.get("query"),
            matches=matches,
            count=len(matches),
            truncated=bool(queue) and len(matches) >= limit,
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_create_folder(args: dict, **kwargs: Any) -> str:
    try:
        name = _safe_name(args.get("name"))
        root = _root()
        parent_token = str(args.get("parent_token") or root["token"]).strip()
        data = _proxy_request(
            "POST",
            "/api/integrations/feishu/drive/folders",
            body={"name": name, "folder_token": parent_token},
        )
        return tool_result(
            success=True,
            user_root=root,
            parent_token=parent_token,
            folder=data,
        )
    except Exception as exc:
        return tool_error(str(exc))


def _resolve_upload_path(value: Any, task_id: str) -> Path:
    raw = str(value or "").strip()
    if not raw:
        raise FeishuDriveError("local_path is required")
    from tools.file_tools import _resolve_path

    resolved = _resolve_path(raw, task_id)
    if isinstance(resolved, PurePosixPath) and not isinstance(resolved, Path):
        raise FeishuDriveError("Uploading from a remote/container path is not supported")
    path = Path(resolved).expanduser().resolve()
    from agent.file_safety import get_read_block_error

    block_error = get_read_block_error(str(path))
    if block_error:
        raise FeishuDriveError(block_error)
    if not path.is_file():
        raise FeishuDriveError("local_path must point to an existing regular file")
    if path.stat().st_size > MAX_UPLOAD_BYTES:
        raise FeishuDriveError("The complete-upload API accepts files up to 20 MiB")
    return path


def _handle_upload_file(args: dict, **kwargs: Any) -> str:
    try:
        task_id = str(kwargs.get("task_id") or "default")
        path = _resolve_upload_path(args.get("local_path"), task_id)
        file_name = _safe_name(args.get("file_name") or path.name)
        root = _root()
        parent_token = str(args.get("parent_token") or root["token"]).strip()
        data = _proxy_request(
            "POST",
            "/api/integrations/feishu/drive/files/upload",
            body={
                "file_name": file_name,
                "parent_node": parent_token,
                "content_base64": base64.b64encode(path.read_bytes()).decode("ascii"),
            },
            timeout=60,
        )
        return tool_result(
            success=True,
            user_root=root,
            parent_token=parent_token,
            local_path=str(path),
            file=data,
        )
    except Exception as exc:
        return tool_error(str(exc))


def _handle_delete_file(args: dict, **kwargs: Any) -> str:
    try:
        file_token = str(args.get("file_token") or "").strip()
        if not file_token:
            raise FeishuDriveError("file_token is required")
        if str(args.get("confirmation") or "") != f"DELETE:{file_token}":
            raise FeishuDriveError(
                f"confirmation must exactly equal DELETE:{file_token}"
            )
        file_type = str(args.get("file_type") or "file").strip().lower()
        if file_type == "folder":
            raise FeishuDriveError("Folder deletion is not supported")
        data = _proxy_request(
            "DELETE",
            f"/api/integrations/feishu/drive/files/{urllib.parse.quote(file_token, safe='')}",
            query={"type": file_type},
        )
        return tool_result(
            success=True,
            deleted={"token": file_token, "type": file_type},
            data=data,
        )
    except Exception as exc:
        return tool_error(str(exc))


FEISHU_DRIVE_LIST_FILES_SCHEMA = {
    "name": "feishu_drive_list_files",
    "description": "List one page of files in the connected user's Feishu Drive. Omit folder_token for the user's root.",
    "parameters": {
        "type": "object",
        "properties": {
            "folder_token": {"type": "string"},
            "page_size": {"type": "integer", "default": 100, "minimum": 1, "maximum": 200},
            "page_token": {"type": "string"},
        },
    },
}

FEISHU_DRIVE_SEARCH_FILES_SCHEMA = {
    "name": "feishu_drive_search_files",
    "description": "Recursively search file and folder names in the connected user's Feishu Drive.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string"},
            "folder_token": {"type": "string"},
            "limit": {"type": "integer", "default": 50, "minimum": 1, "maximum": 200},
        },
        "required": ["query"],
    },
}

FEISHU_DRIVE_CREATE_FOLDER_SCHEMA = {
    "name": "feishu_drive_create_folder",
    "description": "Create a folder in the connected user's Feishu Drive.",
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "parent_token": {"type": "string", "description": "Omit for the user's root."},
        },
        "required": ["name"],
    },
}

FEISHU_DRIVE_UPLOAD_FILE_SCHEMA = {
    "name": "feishu_drive_upload_file",
    "description": "Upload an existing local file (maximum 20 MiB) to the connected user's Feishu Drive.",
    "parameters": {
        "type": "object",
        "properties": {
            "local_path": {"type": "string"},
            "file_name": {"type": "string"},
            "parent_token": {"type": "string", "description": "Omit for the user's root."},
        },
        "required": ["local_path"],
    },
}

FEISHU_DRIVE_DELETE_FILE_SCHEMA = {
    "name": "feishu_drive_delete_file",
    "description": "Permanently delete one file from the connected user's Feishu Drive. Folder deletion is not supported.",
    "parameters": {
        "type": "object",
        "properties": {
            "file_token": {"type": "string"},
            "file_type": {"type": "string", "description": "Type returned by list/search; defaults to file."},
            "confirmation": {"type": "string", "description": "Must exactly equal DELETE:<file_token>."},
        },
        "required": ["file_token", "confirmation"],
    },
}


registry.register(
    name="feishu_drive_list_files",
    toolset="feishu_user_drive",
    schema=FEISHU_DRIVE_LIST_FILES_SCHEMA,
    handler=_handle_list_files,
    check_fn=_check_feishu_drive_files,
    requires_env=[],
    is_async=False,
    description="List personal Feishu Drive files",
    emoji="📂",
    max_result_size_chars=30000,
)

registry.register(
    name="feishu_drive_search_files",
    toolset="feishu_user_drive",
    schema=FEISHU_DRIVE_SEARCH_FILES_SCHEMA,
    handler=_handle_search_files,
    check_fn=_check_feishu_drive_files,
    requires_env=[],
    is_async=False,
    description="Search personal Feishu Drive files",
    emoji="🔎",
    max_result_size_chars=30000,
)

registry.register(
    name="feishu_drive_create_folder",
    toolset="feishu_user_drive",
    schema=FEISHU_DRIVE_CREATE_FOLDER_SCHEMA,
    handler=_handle_create_folder,
    check_fn=_check_feishu_drive_files,
    requires_env=[],
    is_async=False,
    description="Create personal Feishu Drive folder",
    emoji="📁",
    max_result_size_chars=30000,
)

registry.register(
    name="feishu_drive_upload_file",
    toolset="feishu_user_drive",
    schema=FEISHU_DRIVE_UPLOAD_FILE_SCHEMA,
    handler=_handle_upload_file,
    check_fn=_check_feishu_drive_files,
    requires_env=[],
    is_async=False,
    description="Upload to personal Feishu Drive",
    emoji="⬆️",
    max_result_size_chars=30000,
)

registry.register(
    name="feishu_drive_delete_file",
    toolset="feishu_user_drive",
    schema=FEISHU_DRIVE_DELETE_FILE_SCHEMA,
    handler=_handle_delete_file,
    check_fn=_check_feishu_drive_files,
    requires_env=[],
    is_async=False,
    description="Delete personal Feishu Drive file",
    emoji="🗑️",
    max_result_size_chars=30000,
)
