import { describe, expect, it } from "vitest";
import { patchDashboardTextIntegrityTraceSource } from "../scripts/patch-dashboard-text-integrity-trace.mjs";

const SOURCE = `
def _emit(event: str, sid: str, payload: dict | None = None):
    write_json(_event_frame(event, sid, payload))

def finish():
            _retire_turn_marker(session, marker_key)
            _emit("message.complete", sid, payload)
`;

describe("dashboard text-integrity runtime patch", () => {
  // @lat: [[main-process#Text integrity diagnostics]]
  it("adds emit and database trace points idempotently", () => {
    const once = patchDashboardTextIntegrityTraceSource(SOURCE);
    const twice = patchDashboardTextIntegrityTraceSource(once);

    expect(once).toContain("record_backend_emit(event, sid, payload)");
    expect(once).toContain("record_database_snapshot(sid, session, agent)");
    expect(twice).toBe(once);
  });
});
