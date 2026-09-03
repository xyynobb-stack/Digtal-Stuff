import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchProfileSessionIsolation } from "../scripts/patch-profile-session-isolation.mjs";

const tempRoots: string[] = [];
const patchedFiles = [
  "agent/title_generator.py",
  "tui_gateway/server.py",
  "tui_gateway/methods_prompt.py",
  "tui_gateway/methods_session.py",
  "tui_gateway/methods_tools.py",
];

function createBaselineAgent(): string {
  const agentRoot = mkdtempSync(join(tmpdir(), "jingyu-profile-overlay-"));
  tempRoots.push(agentRoot);
  for (const relativePath of patchedFiles) {
    const target = join(agentRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      execFileSync("git", [
        "show",
        `HEAD:build/offline-runtime/hermes-agent/${relativePath}`,
      ]),
    );
  }
  return agentRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Profile session isolation build overlay", () => {
  // @lat: [[main-process#Offline Windows runtime#Profile isolation release overlay]]
  it("patches a clean Agent tree once and is then idempotent", () => {
    const agentRoot = createBaselineAgent();

    expect(patchProfileSessionIsolation(agentRoot)).toBe(true);
    expect(patchProfileSessionIsolation(agentRoot)).toBe(false);

    const server = readFileSync(
      join(agentRoot, "tui_gateway/server.py"),
      "utf8",
    );
    const promptMethods = readFileSync(
      join(agentRoot, "tui_gateway/methods_prompt.py"),
      "utf8",
    );
    const titleGenerator = readFileSync(
      join(agentRoot, "agent/title_generator.py"),
      "utf8",
    );

    expect(server).toContain("def _session_db(session: dict):");
    expect(server).toContain("def _session_environment(");
    expect(promptMethods).toContain("_bound_session_db");
    expect(titleGenerator).toContain("session_db_factory");
  });

  it("finishes a compatible tree that already contains local overlays", () => {
    const agentRoot = createBaselineAgent();
    const serverPath = join(agentRoot, "tui_gateway/server.py");
    const server = readFileSync(serverPath, "utf8").replace(
      "                        title_text,\n                        raw,",
      "                        text,\n                        raw,",
    );
    writeFileSync(serverPath, server, "utf8");

    expect(patchProfileSessionIsolation(agentRoot)).toBe(true);
    expect(patchProfileSessionIsolation(agentRoot)).toBe(false);
    expect(readFileSync(serverPath, "utf8")).toContain(
      "session_db_factory=lambda _s=_title_db_session",
    );
  });
});
