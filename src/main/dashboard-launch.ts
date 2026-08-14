import { delimiter } from "path";

export function dashboardCliArgs(
  profile: string | undefined,
  command: string[],
): string[] {
  return profile ? ["--profile", profile, ...command] : command;
}

export function buildLocalDashboardCliArgs(
  profile: string | undefined,
  port: number,
): string[] {
  const args = dashboardCliArgs(profile, [
    "serve",
    "--isolated",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  return args;
}

/**
 * Make the managed Agent source importable when Python starts outside the
 * repository. Offline Windows venvs can contain editable-install metadata
 * that still points at the CI checkout, so a neutral Dashboard cwd must not
 * rely on that metadata to resolve `hermes_cli`.
 */
export function withPythonSourceRoot(
  baseEnv: NodeJS.ProcessEnv,
  sourceRoot: string,
  pathDelimiter = delimiter,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HERMES_PYTHON_SRC_ROOT: sourceRoot,
  };
  const existingEntries = (env.PYTHONPATH || "")
    .split(pathDelimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => entry !== sourceRoot);
  env.PYTHONPATH = [sourceRoot, ...existingEntries].join(pathDelimiter);
  return env;
}
