import { describe, expect, it, vi } from "vitest";
import { initializeRuntimeAndWarmLocalDashboard } from "./runtime-dashboard-warmup";

describe("runtime Dashboard warm-up", () => {
  // @lat: [[chat-commands#Layered desktop readiness]]
  it("starts the local Dashboard only after Runtime readiness", async () => {
    let releaseRuntime!: () => void;
    const initializeRuntime = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseRuntime = resolve;
        }),
    );
    const startLocalDashboard = vi.fn(async () => ({ running: true }));
    const pending = initializeRuntimeAndWarmLocalDashboard({
      initializeRuntime,
      getConnectionMode: () => "local",
      startLocalDashboard,
    });

    await Promise.resolve();
    expect(startLocalDashboard).not.toHaveBeenCalled();
    releaseRuntime();
    await pending;

    expect(startLocalDashboard).toHaveBeenCalledTimes(1);
  });

  it("does not spawn a local Dashboard for remote transports", async () => {
    const startLocalDashboard = vi.fn(async () => ({ running: true }));

    await initializeRuntimeAndWarmLocalDashboard({
      initializeRuntime: async () => undefined,
      getConnectionMode: () => "ssh",
      startLocalDashboard,
    });

    expect(startLocalDashboard).not.toHaveBeenCalled();
  });
});
