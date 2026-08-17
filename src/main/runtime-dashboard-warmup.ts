export interface RuntimeDashboardWarmupDependencies {
  initializeRuntime: () => Promise<void>;
  getConnectionMode: () => "local" | "remote" | "ssh";
  startLocalDashboard: () => Promise<{
    running: boolean;
    error?: string;
  }>;
}

/**
 * Resolve the versioned Runtime before starting the local Dashboard. Keeping
 * this chain in the main process means chat-page mount timing cannot postpone
 * backend pre-warming, while remote/SSH modes remain untouched.
 */
// @lat: [[chat-commands#Layered desktop readiness]]
export async function initializeRuntimeAndWarmLocalDashboard(
  dependencies: RuntimeDashboardWarmupDependencies,
): Promise<void> {
  await dependencies.initializeRuntime();
  if (dependencies.getConnectionMode() !== "local") return;

  const status = await dependencies.startLocalDashboard();
  if (!status.running) {
    throw new Error(
      status.error || "JingYuAI Dashboard pre-warm did not become ready",
    );
  }
}
