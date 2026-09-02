import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";
import { stopChildProcessAndWait } from "./child-process-stop";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  kill = vi.fn(() => true);
}

describe("managed child process shutdown", () => {
  it("waits for the exit event after signalling the process", async () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Dashboard handle release]]
    const process = new FakeChildProcess();
    const stopped = stopChildProcessAndWait(process, 1000);

    expect(process.kill).toHaveBeenCalledTimes(1);
    let resolved = false;
    void stopped.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    process.exitCode = 0;
    process.emit("exit", 0, null);
    await expect(stopped).resolves.toBe(true);
  });

  it("reports a process that remains alive after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const process = new FakeChildProcess();
      const stopped = stopChildProcessAndWait(process, 5000);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(stopped).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
