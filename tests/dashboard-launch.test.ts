import { describe, expect, it } from "vitest";
import { buildLocalDashboardCliArgs } from "../src/main/dashboard-launch";

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
});
