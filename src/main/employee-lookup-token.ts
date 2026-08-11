const EMPLOYEE_LOOKUP_TOKEN_LINE =
  /^\s*EMPLOYEE_LOOKUP_ADMIN_TOKEN\s*=\s*(.*?)\s*$/m;

/**
 * Replace every existing employee lookup token entry with the token bundled
 * in the current installer. This deliberately refreshes stale or empty values
 * left by an older source checkout or application build.
 */
export function mergeBundledEmployeeLookupToken(
  existingEnv: string,
  bundledEnv: string,
): string {
  const match = bundledEnv.match(EMPLOYEE_LOOKUP_TOKEN_LINE);
  const token = match?.[1]?.replace(/^['"]|['"]$/g, "").trim() ?? "";
  if (!token) {
    throw new Error("Bundled employee lookup token is empty.");
  }

  const withoutOldToken = existingEnv
    .replace(/^\s*EMPLOYEE_LOOKUP_ADMIN_TOKEN\s*=.*(?:\r?\n|$)/gm, "")
    .trimEnd();
  return `${withoutOldToken}${withoutOldToken ? "\n" : ""}EMPLOYEE_LOOKUP_ADMIN_TOKEN=${token}\n`;
}
