"""Deterministic Feishu Drive delivery for desktop cron jobs.

The desktop UI uses ``deliver=feishu`` for Drive delivery rather than the
upstream Feishu chat adapter.  Each run gets an isolated local output folder;
files produced there are uploaded with the employee's user-authorized Drive
connection after the agent finishes.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from hermes_constants import get_hermes_home


DELIVERY_PREFIX = "feishu"
RUN_OUTPUT_KEY = "_desktop_feishu_drive_output_dir"
DELIVERY_MANIFEST = ".feishu-drive-delivery.json"


def _delivery_value(job: dict[str, Any]) -> str:
    raw = job.get("deliver", "local")
    if isinstance(raw, (list, tuple)):
        raw = raw[0] if len(raw) == 1 else ",".join(str(item) for item in raw)
    return str(raw or "local").strip()


def is_feishu_drive_delivery(job: dict[str, Any]) -> bool:
    """Return whether this desktop cron job targets Feishu Drive."""
    value = _delivery_value(job)
    return value == DELIVERY_PREFIX or value.startswith(f"{DELIVERY_PREFIX}:")


def delivery_folder_token(job: dict[str, Any]) -> Optional[str]:
    """Return the optional explicit Drive folder token stored in deliver."""
    value = _delivery_value(job)
    if not value.startswith(f"{DELIVERY_PREFIX}:"):
        return None
    token = value.split(":", 1)[1].strip()
    return token or None


def prepare_run_output_dir(job: dict[str, Any]) -> Optional[str]:
    """Create and cache an isolated deliverables directory for this run."""
    if not is_feishu_drive_delivery(job):
        return None
    existing = str(job.get(RUN_OUTPUT_KEY) or "").strip()
    if existing:
        return existing
    job_id = re.sub(r"[^A-Za-z0-9_-]", "_", str(job.get("id") or "job"))[:80]
    run_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    target = get_hermes_home() / "cron" / "feishu-drive" / job_id / run_id
    target.mkdir(parents=True, exist_ok=False)
    job[RUN_OUTPUT_KEY] = str(target)
    return str(target)


def build_delivery_prompt(job: dict[str, Any]) -> str:
    """Tell the agent what counts as a Drive deliverable."""
    if not is_feishu_drive_delivery(job):
        return ""
    target = delivery_folder_token(job)
    destination = f"飞书文件夹 token：{target}" if target else "当前用户的“我的文件夹”根目录"
    return (
        "[Feishu Drive delivery]\n"
        f"本次计划任务的最终文件将由调度器上传到{destination}。\n"
        "所有新生成或由本地文件修改得到的成品都必须保存到上方指定的计划任务输出目录；"
        "不要覆盖写作模板，也不要自行调用消息发送或飞书上传工具。"
        "只把最终成品放入该目录，临时文件和中间文件应放在其他位置。"
        "如果任务直接修改既有飞书在线文档或电子表格，可使用对应飞书工具完成修改，"
        "并在最终回复中说明修改对象。"
    )


def _safe_result_name(job: dict[str, Any]) -> str:
    name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", str(job.get("name") or "计划任务结果"))
    name = name.strip(" ._")[:80] or "计划任务结果"
    return f"{name}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.md"


def _collect_deliverables(output_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in output_dir.rglob("*")
        if path.is_file()
        and path.name != DELIVERY_MANIFEST
        and not any(part.startswith(".") for part in path.relative_to(output_dir).parts)
    )


def deliver_job_output(job: dict[str, Any], content: str) -> Optional[str]:
    """Upload this run's deliverables and return an error string on failure."""
    output_value = prepare_run_output_dir(job)
    if not output_value:
        return "Feishu Drive delivery output directory was not prepared"
    output_dir = Path(output_value)
    deliverables = _collect_deliverables(output_dir)
    if not deliverables:
        fallback = output_dir / _safe_result_name(job)
        fallback.write_text(content.strip() + "\n", encoding="utf-8")
        deliverables = [fallback]

    from agent.secret_scope import (
        build_profile_secret_scope,
        reset_secret_scope,
        set_secret_scope,
    )
    from tools.feishu_drive_files_tool import _handle_upload_file

    scope_token = set_secret_scope(build_profile_secret_scope(get_hermes_home()))
    uploaded: list[dict[str, Any]] = []
    errors: list[str] = []
    try:
        for path in deliverables:
            args: dict[str, Any] = {
                "local_path": str(path),
                "file_name": path.name,
            }
            folder_token = delivery_folder_token(job)
            if folder_token:
                args["parent_token"] = folder_token
            try:
                result = json.loads(
                    _handle_upload_file(args, task_id=f"cron-{job.get('id', 'job')}")
                )
            except Exception as exc:
                errors.append(f"{path.name}: {exc}")
                continue
            if not result.get("success"):
                errors.append(f"{path.name}: {result.get('error') or 'upload failed'}")
                continue
            uploaded.append(
                {
                    "local_path": str(path),
                    "file_name": path.name,
                    "parent_token": result.get("parent_token"),
                    "file": result.get("file"),
                }
            )
    finally:
        reset_secret_scope(scope_token)

    manifest = {
        "version": 1,
        "job_id": str(job.get("id") or ""),
        "destination": delivery_folder_token(job) or "personal_root",
        "uploaded": uploaded,
        "errors": errors,
    }
    (output_dir / DELIVERY_MANIFEST).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if errors:
        return "Feishu Drive upload failed: " + "; ".join(errors)
    return None
