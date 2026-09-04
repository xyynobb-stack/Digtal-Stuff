import {
  getDashboardStatus,
  startDashboard,
  stopDashboardAndWait,
  type DashboardStatus,
} from "./dashboard";

export interface FeishuDashboardRefreshResult {
  attempted: boolean;
  ok: boolean;
  error?: string;
}

interface FeishuDashboardRefreshDeps {
  getStatus(profile: string): Promise<DashboardStatus>;
  stopAndWait(profile: string): Promise<boolean>;
  start(profile: string): Promise<DashboardStatus>;
}

const defaultDeps: FeishuDashboardRefreshDeps = {
  getStatus: getDashboardStatus,
  stopAndWait: (profile) => stopDashboardAndWait(profile),
  start: startDashboard,
};

/**
 * Rebuild the local Dashboard's cached Agent/tool snapshots after a profile
 * receives new credentials. The renderer and profile database stay intact;
 * its WebSocket reconnect path resumes sessions against the replacement
 * process.
 */
export async function refreshDashboardAfterFeishuAuthorization(
  profile: string,
  deps: FeishuDashboardRefreshDeps = defaultDeps,
): Promise<FeishuDashboardRefreshResult> {
  try {
    const status = await deps.getStatus(profile);
    if (!status.running || status.connection?.mode !== "local") {
      return { attempted: false, ok: true };
    }

    if (!(await deps.stopAndWait(profile))) {
      return {
        attempted: true,
        ok: false,
        error: "Dashboard process did not stop cleanly.",
      };
    }

    const restarted = await deps.start(profile);
    if (!restarted.running || !restarted.connection) {
      return {
        attempted: true,
        ok: false,
        error: restarted.error || "Dashboard process did not become ready.",
      };
    }
    return { attempted: true, ok: true };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
