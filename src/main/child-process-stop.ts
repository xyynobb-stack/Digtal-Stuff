interface WaitableChildProcess {
  exitCode: number | null;
  kill(): boolean;
  once(event: "exit", listener: () => void): unknown;
  removeListener(event: "exit", listener: () => void): unknown;
}

/** Signal a managed child once and resolve only after Node observes its exit. */
export function stopChildProcessAndWait(
  child: WaitableChildProcess,
  timeoutMs = 5000,
): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (stopped: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(stopped);
    };
    const onExit = (): void => finish(true);

    child.once("exit", onExit);
    try {
      child.kill();
    } catch {
      finish(false);
      return;
    }
    if (child.exitCode !== null) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
  });
}
