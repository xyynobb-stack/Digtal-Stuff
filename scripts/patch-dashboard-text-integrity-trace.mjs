function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Dashboard text-trace marker not found: ${label}`);
  }
  return source.replace(before, after);
}

/**
 * Add opt-in backend emit and SessionDB trace points without forking the
 * upstream gateway server. The copied helper is inert unless the Desktop main
 * process exports HERMES_TEXT_INTEGRITY_TRACE_FILE.
 */
export function patchDashboardTextIntegrityTraceSource(source) {
  if (
    source.includes("record_backend_emit(event, sid, payload)") &&
    source.includes("record_database_snapshot(sid, session, agent)")
  ) {
    return source;
  }

  let patched = replaceRequired(
    source,
    `def _emit(event: str, sid: str, payload: dict | None = None):\n    write_json(_event_frame(event, sid, payload))`,
    `def _emit(event: str, sid: str, payload: dict | None = None):\n    # Development-only text integrity tracing; the helper is inert unless the\n    # Desktop explicitly supplies HERMES_TEXT_INTEGRITY_TRACE_FILE.\n    try:\n        from tui_gateway.text_integrity_trace import record_backend_emit\n\n        trace_meta = record_backend_emit(event, sid, payload)\n        if trace_meta and isinstance(payload, dict):\n            payload = {**payload, "_text_trace": trace_meta}\n    except Exception:\n        pass\n    write_json(_event_frame(event, sid, payload))`,
    "backend emit",
  );

  patched = replaceRequired(
    patched,
    `            _retire_turn_marker(session, marker_key)\n            _emit("message.complete", sid, payload)`,
    `            _retire_turn_marker(session, marker_key)\n            try:\n                from tui_gateway.text_integrity_trace import record_database_snapshot\n\n                record_database_snapshot(sid, session, agent)\n            except Exception:\n                pass\n            _emit("message.complete", sid, payload)`,
    "database snapshot",
  );
  return patched;
}
