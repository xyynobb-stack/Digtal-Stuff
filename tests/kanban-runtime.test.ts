import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileSpy } = vi.hoisted(() => ({
  execFileSpy: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileSpy,
  default: { execFile: execFileSpy },
}));
vi.mock("../src/main/installer", () => ({
  HERMES_HOME: "C:/hermes-data",
  HERMES_REPO: "C:/desktop-runtime/hermes-agent",
  HERMES_PYTHON: process.execPath,
  getEnhancedPath: () => "C:/enhanced-path",
  hermesCliArgs: (args: string[] = []) => ["-m", "hermes_cli.main", ...args],
}));
vi.mock("../src/main/hermes", () => ({ isRemoteOnlyMode: () => false }));
vi.mock("../src/main/config", () => ({
  getConnectionConfig: () => ({ mode: "local" }),
}));
vi.mock("../src/main/ssh-remote", () => ({
  sshRunKanban: vi.fn(),
  sshListClaw3dHqTasks: vi.fn(),
}));

describe("local Kanban runtime", () => {
  beforeEach(() => {
    execFileSpy.mockReset();
    execFileSpy.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (err: Error | null, stdout: string, stderr: string) => void,
      ) => callback(null, "[]", ""),
    );
  });

  it("runs from the packaged repository with the resolved Hermes home", async () => {
    const { listBoards } = await import("../src/main/kanban");

    await expect(listBoards()).resolves.toEqual({ success: true, data: [] });
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy.mock.calls[0][1]).toEqual([
      "-m",
      "hermes_cli.main",
      "kanban",
      "boards",
      "list",
      "--json",
    ]);
    expect(execFileSpy.mock.calls[0][2]).toMatchObject({
      cwd: "C:/desktop-runtime/hermes-agent",
      env: expect.objectContaining({
        HERMES_HOME: "C:/hermes-data",
        PATH: "C:/enhanced-path",
      }),
    });
  });
});
