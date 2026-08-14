import { describe, expect, it } from "vitest";
import {
  buildLocalDashboardCliArgs,
  withPythonSourceRoot,
} from "../src/main/dashboard-launch";

describe("local dashboard launch args", () => {
  it("matches the current upstream desktop dashboard command shape", () => {
    expect(buildLocalDashboardCliArgs(undefined, 9123)).toEqual([
      "serve",
      "--isolated",
      "--host",
      "127.0.0.1",
      "--port",
      "9123",
    ]);
  });

  it("preserves the profile while staying independent of dashboard web assets", () => {
    const args = buildLocalDashboardCliArgs("work", 9123);

    expect(args).toEqual([
      "--profile",
      "work",
      "serve",
      "--isolated",
      "--host",
      "127.0.0.1",
      "--port",
      "9123",
    ]);
    expect(args).not.toContain("--tui");
    expect(args).not.toContain("--skip-build");
  });

  it("keeps the managed Agent importable from a neutral working directory", () => {
    const original = {
      PATH: "C:\\Windows\\System32",
      PYTHONPATH: "C:\\existing;C:\\runtime\\hermes-agent",
    };

    const env = withPythonSourceRoot(
      original,
      "C:\\runtime\\hermes-agent",
      ";",
    );

    expect(env.HERMES_PYTHON_SRC_ROOT).toBe("C:\\runtime\\hermes-agent");
    expect(env.PYTHONPATH).toBe("C:\\runtime\\hermes-agent;C:\\existing");
    expect(original.PYTHONPATH).toBe("C:\\existing;C:\\runtime\\hermes-agent");
  });
});
