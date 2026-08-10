import { describe, expect, it, vi } from "vitest";

vi.mock("./installer", () => ({
  HERMES_HOME: "C:/tmp/hermes-test",
  HERMES_REPO: "C:/tmp/hermes-test/hermes-agent",
}));
vi.mock("./ssh-remote", () => ({ sshExec: vi.fn() }));

import { patchDashboardSlashModelSyncSource } from "./hermes-agent-compat";

const lazySource = `def _mirror_slash_side_effects(name, arg, session, sid):
        agent = session.get("agent")
        if name == "model" and arg and agent:
            result = _apply_model_switch(sid, session, arg)
            return result.get("warning", "")
        return ""
`;

describe("dashboard slash model compatibility", () => {
  it("waits for the live Agent before mirroring a successful model switch", () => {
    const patched = patchDashboardSlashModelSyncSource(lazySource);

    expect(patched.compatible).toBe(true);
    expect(patched.changed).toBe(true);
    expect(patched.source).toContain("_start_agent_build(sid, session)");
    expect(patched.source).toContain(
      '_wait_agent(session, f"__slash_model_sync__{sid}")',
    );
    expect(patched.source).not.toContain(
      'if name == "model" and arg and agent:',
    );
  });

  it("is idempotent after the live-session patch is installed", () => {
    const once = patchDashboardSlashModelSyncSource(lazySource);
    const twice = patchDashboardSlashModelSyncSource(once.source);

    expect(twice.compatible).toBe(true);
    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
  });

  it("patches Windows CRLF runtime files without changing their line endings", () => {
    const windowsSource = lazySource.replace(/\n/g, "\r\n");
    const patched = patchDashboardSlashModelSyncSource(windowsSource);

    expect(patched.compatible).toBe(true);
    expect(patched.changed).toBe(true);
    expect(patched.source).toContain("_start_agent_build(sid, session)\r\n");
    expect(patched.source.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("reports an incompatible upstream shape instead of editing blindly", () => {
    const result = patchDashboardSlashModelSyncSource("def unrelated(): pass");

    expect(result.compatible).toBe(false);
    expect(result.changed).toBe(false);
  });
});
