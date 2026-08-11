import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const { execFileSpy } = vi.hoisted(() => ({
  execFileSpy: vi.fn(
    (
      _file: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (err: Error | null, stdout: string, stderr: string) => void,
    ) => callback(null, "ok", ""),
  ),
}));

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));

vi.mock("../src/main/utils", () => ({
  profileHome: () => "C:/hermes",
}));

vi.mock("../src/main/hermes", () => ({
  isRemoteMode: () => false,
  getApiUrl: () => "http://127.0.0.1:8642",
  getRemoteAuthHeader: () => ({}),
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "C:/hermes",
  HERMES_REPO: "C:/desktop-runtime/hermes-agent",
  HERMES_PYTHON: "C:/hermes/hermes-agent/venv/Scripts/pythonw.exe",
  getEnhancedPath: () => "C:/enhanced-path",
  hermesCliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
}));

let cronjobs: typeof import("../src/main/cronjobs");

beforeAll(async () => {
  cronjobs = await import("../src/main/cronjobs");
}, 20000);

describe("createCronJob", () => {
  beforeEach(() => {
    execFileSpy.mockReset();
    execFileSpy.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "ok", ""),
    );
  });

  it("passes the prompt as the cron create positional argument before flags", async () => {
    await cronjobs.createCronJob(
      "7 17 * * *",
      "Create a daily brief with local news, weather, and quotes.",
      "Daily brief",
      "telegram",
    );

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "create",
      "7 17 * * *",
      "Create a daily brief with local news, weather, and quotes.",
      "--name",
      "Daily brief",
      "--deliver",
      "telegram",
    ]);
    expect(execFileSpy.mock.calls[0][1]).not.toContain("--");
  });

  it("pins a selected model and provider on new jobs", async () => {
    await cronjobs.createCronJob(
      "0 15 * * *",
      "Back up the code.",
      "Backup",
      undefined,
      undefined,
      "kimi-k2.5",
      "kimi-coding",
    );

    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "create",
      "0 15 * * *",
      "Back up the code.",
      "--name",
      "Backup",
      "--model",
      "kimi-k2.5",
      "--provider",
      "kimi-coding",
    ]);
  });

  it("stores a user-selected output root on the cron job", async () => {
    await cronjobs.createCronJob(
      "0 9 * * *",
      "Write the daily report.",
      "Daily report",
      undefined,
      undefined,
      "glm-5",
      "company-platform",
      "C:/Reports/JingYuAI",
    );

    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "create",
      "0 9 * * *",
      "Write the daily report.",
      "--name",
      "Daily report",
      "--model",
      "glm-5",
      "--provider",
      "company-platform",
      "--output-dir",
      "C:/Reports/JingYuAI",
    ]);
  });

  it("runs the CLI from the packaged repository with the resolved Hermes home", async () => {
    await cronjobs.triggerCronJob("job-123");

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "run",
      "job-123",
    ]);
    expect(execFileSpy.mock.calls[0][2]).toMatchObject({
      cwd: "C:/desktop-runtime/hermes-agent",
      timeout: 0,
      env: expect.objectContaining({
        HERMES_HOME: "C:/hermes",
        PATH: "C:/enhanced-path",
      }),
    });
  });

  it("surfaces CLI stdout when a cron action exits with no stderr", async () => {
    execFileSpy.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(new Error("Command failed"), "Job not found: missing", ""),
    );
    await expect(cronjobs.triggerCronJob("missing")).resolves.toEqual({
      success: false,
      error: "Job not found: missing",
    });
  });

  it("pins the configured model before running a legacy job", async () => {
    await cronjobs.triggerCronJob("legacy-job", undefined, "glm-5", "zai");

    expect(execFileSpy).toHaveBeenCalledTimes(2);
    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "edit",
      "legacy-job",
      "--model",
      "glm-5",
      "--provider",
      "zai",
    ]);
    expect(execFileSpy.mock.calls[1][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "cron",
      "run",
      "legacy-job",
    ]);
  });
});

describe("parseCronListOutput", () => {
  it("parses the Hermes cron list table used by SSH profiles", async () => {
    const jobs = cronjobs.parseCronListOutput(`
┌─────────────────────────────────────────────────────────────────────────┐
│                         Scheduled Jobs                                  │
└─────────────────────────────────────────────────────────────────────────┘

  321a3a33703e [active]
    Name:      daily-daegu-startup-grant-monitoring
    Schedule:  0 9 * * *
    Repeat:    ∞
    Next run:  2026-06-25T09:00:00+09:00
    Deliver:   origin
    Model:     kimi-k2.5
    Provider:  kimi-coding
    Output dir: /srv/reports
    Workdir:   /workspaces/biz-office
    Last run:  2026-06-24T09:16:46.248027+09:00  ok

  85e1165b00eb [paused]
    Name:      server-emergency-watchdog
    Schedule:  every 10m
    Repeat:    2/5
    Next run:  2026-06-24T23:00:40.707549+09:00
    Deliver:   discord:channel-123
    Script:    server_emergency_watchdog.py
    Mode:      no-agent (script stdout delivered directly)
`);

    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      id: "321a3a33703e",
      name: "daily-daegu-startup-grant-monitoring",
      schedule: "0 9 * * *",
      state: "active",
      enabled: true,
      next_run_at: "2026-06-25T09:00:00+09:00",
      last_run_at: "2026-06-24T09:16:46.248027+09:00",
      last_status: "ok",
      repeat: { times: null, completed: 0 },
      deliver: ["origin"],
      model: "kimi-k2.5",
      provider: "kimi-coding",
      output_dir: "/srv/reports",
    });
    expect(jobs[1]).toMatchObject({
      id: "85e1165b00eb",
      state: "paused",
      enabled: false,
      repeat: { times: 5, completed: 2 },
      deliver: ["discord:channel-123"],
      script: "server_emergency_watchdog.py",
    });
  });
});
