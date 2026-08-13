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
