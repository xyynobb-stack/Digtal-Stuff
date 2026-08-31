"""Opt-in cross-layer text tracing for JingYuAI Desktop diagnostics.

The module is inert unless ``HERMES_TEXT_INTEGRITY_TRACE_FILE`` is set by the
Desktop main process. Trace files can contain conversation text and are meant
only for controlled local reproductions.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any


_MAX_TEXT_CHARS = 512_000
_lock = threading.Lock()
_turn_counters: dict[str, int] = {}
_turn_keys: dict[str, str] = {}
_event_sequences: dict[str, int] = {}


def _trace_path() -> Path | None:
    raw = str(os.environ.get("HERMES_TEXT_INTEGRITY_TRACE_FILE") or "").strip()
    return Path(raw) if raw else None


def _flatten_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        chunks: list[str] = []
        for item in value:
            if isinstance(item, str):
                chunks.append(item)
            elif isinstance(item, dict):
                chunks.append(
                    _flatten_text(item.get("text") or item.get("output_text") or "")
                )
        return "".join(chunks)
    if isinstance(value, dict):
        return _flatten_text(value.get("text") or value.get("output_text") or "")
    return "" if value is None else str(value)


def _payload_text(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return ""
    for key in ("final_response", "content", "text", "rendered", "delta"):
        text = _flatten_text(payload.get(key))
        if text:
            return text
    return ""


def _write_record(
    *,
    stage: str,
    session_id: str,
    turn_key: str,
    sequence: int,
    event_type: str,
    text: str,
    detail: str = "",
) -> None:
    path = _trace_path()
    if path is None:
        return
    full_text = text if isinstance(text, str) else str(text or "")
    record = {
        "stage": stage,
        "source": "backend",
        "atMs": int(time.time() * 1000),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
        "sessionId": session_id,
        "backendTurnKey": turn_key,
        "sequence": sequence,
        "eventType": event_type,
        "text": full_text[:_MAX_TEXT_CHARS],
        "textLength": len(full_text),
        "textSha256": hashlib.sha256(full_text.encode("utf-8")).hexdigest(),
        "textTruncated": len(full_text) > _MAX_TEXT_CHARS,
    }
    if detail:
        record["detail"] = detail[:1_000]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with _lock:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line)
    except Exception:
        # A diagnostic file must never change the active conversation.
        return


def _current_turn_key(session_id: str, *, begin: bool = False) -> str:
    with _lock:
        if begin or session_id not in _turn_keys:
            counter = _turn_counters.get(session_id, 0) + 1
            _turn_counters[session_id] = counter
            _turn_keys[session_id] = f"{session_id}:{counter}"
            _event_sequences[session_id] = 0
        return _turn_keys[session_id]


def _next_sequence(session_id: str) -> int:
    with _lock:
        sequence = _event_sequences.get(session_id, 0) + 1
        _event_sequences[session_id] = sequence
        return sequence


# @lat: [[main-process#Text integrity diagnostics]]
def record_backend_emit(
    event: str,
    session_id: str,
    payload: dict | None,
) -> dict[str, Any] | None:
    """Record exactly what ``_emit`` is about to hand to the transport."""
    if _trace_path() is None or not event.startswith("message."):
        return None
    turn_key = _current_turn_key(session_id, begin=event == "message.start")
    sequence = _next_sequence(session_id)
    _write_record(
        stage="backend.emit",
        session_id=session_id,
        turn_key=turn_key,
        sequence=sequence,
        event_type=event,
        text=_payload_text(payload),
    )
    return {"turn_key": turn_key, "sequence": sequence}


def _conversation_rows(db: Any, session_key: str) -> list[dict]:
    try:
        rows = db.get_messages_as_conversation(
            session_key,
            include_ancestors=True,
            include_row_ids=True,
        )
    except TypeError:
        rows = db.get_messages_as_conversation(session_key, include_ancestors=True)
    return rows if isinstance(rows, list) else []


def record_database_snapshot(session_id: str, session: dict, agent: Any) -> None:
    """Record assistant rows persisted after the latest user row."""
    if _trace_path() is None:
        return
    turn_key = _current_turn_key(session_id)
    db = getattr(agent, "_session_db", None)
    session_key = str(
        getattr(agent, "session_id", None) or session.get("session_key") or ""
    )
    if db is None or not session_key:
        _write_record(
            stage="database.snapshot",
            session_id=session_id,
            turn_key=turn_key,
            sequence=0,
            event_type="assistant",
            text="",
            detail="SessionDB or session key unavailable",
        )
        return
    try:
        rows = _conversation_rows(db, session_key)
        latest_turn: list[dict] = []
        for row in reversed(rows):
            if not isinstance(row, dict):
                continue
            if row.get("role") == "user":
                break
            latest_turn.append(row)
        latest_turn.reverse()
        assistant_rows = [row for row in latest_turn if row.get("role") == "assistant"]
        if not assistant_rows:
            _write_record(
                stage="database.snapshot",
                session_id=session_id,
                turn_key=turn_key,
                sequence=0,
                event_type="assistant",
                text="",
                detail="No assistant row found after latest user row",
            )
            return
        for index, row in enumerate(assistant_rows, start=1):
            row_id = row.get("_row_id") or row.get("id") or ""
            _write_record(
                stage="database.snapshot",
                session_id=session_id,
                turn_key=turn_key,
                sequence=index,
                event_type="assistant",
                text=_flatten_text(row.get("content")),
                detail=f"row={row_id}; segment={index}/{len(assistant_rows)}",
            )
    except Exception as exc:
        _write_record(
            stage="database.snapshot",
            session_id=session_id,
            turn_key=turn_key,
            sequence=0,
            event_type="assistant",
            text="",
            detail=f"snapshot failed: {type(exc).__name__}: {exc}",
        )
