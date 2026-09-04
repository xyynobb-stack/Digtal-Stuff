import { describe, expect, it, vi } from "vitest";
import { refreshDashboardAfterFeishuAuthorization } from "./feishu-dashboard-refresh";

const running = {
  supported: true,
  running: true,
  connection: {
    baseUrl: "http://127.0.0.1:1",
    wsUrl: "ws://127.0.0.1:1",
    token: "test-token",
    authMode: "token" as const,
    mode: "local" as const,
    profile: "employee-a",
  },
};

describe("refreshDashboardAfterFeishuAuthorization", () => {
  it("restarts only the authorized profile's running local Dashboard", async () => {
    const stopAndWait = vi.fn(async () => true);
    const start = vi.fn(async () => running);
    const result = await refreshDashboardAfterFeishuAuthorization(
      "employee-a",
      {
        getStatus: vi.fn(async () => running),
        stopAndWait,
        start,
      },
    );

    expect(result).toEqual({ attempted: true, ok: true });
    expect(stopAndWait).toHaveBeenCalledWith("employee-a");
    expect(start).toHaveBeenCalledWith("employee-a");
  });

  it("does not start a Dashboard that was not already running", async () => {
    const stopAndWait = vi.fn();
    const start = vi.fn();
    const result = await refreshDashboardAfterFeishuAuthorization(
      "employee-a",
      {
        getStatus: vi.fn(async () => ({ supported: true, running: false })),
        stopAndWait,
        start,
      },
    );

    expect(result).toEqual({ attempted: false, ok: true });
    expect(stopAndWait).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("does not start a replacement when shutdown fails", async () => {
    const start = vi.fn();
    const result = await refreshDashboardAfterFeishuAuthorization(
      "employee-a",
      {
        getStatus: vi.fn(async () => running),
        stopAndWait: vi.fn(async () => false),
        start,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("did not stop");
    expect(start).not.toHaveBeenCalled();
  });

  it("reports replacement startup failure", async () => {
    const result = await refreshDashboardAfterFeishuAuthorization(
      "employee-a",
      {
        getStatus: vi.fn(async () => running),
        stopAndWait: vi.fn(async () => true),
        start: vi.fn(async () => ({
          supported: true,
          running: false,
          error: "probe failed",
        })),
      },
    );

    expect(result).toEqual({
      attempted: true,
      ok: false,
      error: "probe failed",
    });
  });

  it("turns lifecycle exceptions into a refresh failure", async () => {
    const result = await refreshDashboardAfterFeishuAuthorization(
      "employee-a",
      {
        getStatus: vi.fn(async () => {
          throw new Error("status failed");
        }),
        stopAndWait: vi.fn(),
        start: vi.fn(),
      },
    );

    expect(result).toEqual({
      attempted: true,
      ok: false,
      error: "status failed",
    });
  });
});
