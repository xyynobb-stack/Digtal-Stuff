const AIHUB_KEY_LINE = /^\s*AIHUB_API_KEY\s*=\s*(.*?)\s*$/m;

function cleanValue(value: string): string {
  return value.replace(/^['"]|['"]$/g, "").trim();
}

/** Add a build-managed fallback key without replacing a profile value. */
export function mergeBundledAihubKey(
  existingEnv: string,
  bundledEnv: string,
): string {
  const bundled = cleanValue(bundledEnv.match(AIHUB_KEY_LINE)?.[1] ?? "");
  if (!bundled) throw new Error("Bundled AIHub fallback key is empty.");

  const existing = cleanValue(existingEnv.match(AIHUB_KEY_LINE)?.[1] ?? "");
  if (existing) return existingEnv;

  const withoutEmpty = existingEnv
    .replace(/^\s*AIHUB_API_KEY\s*=.*(?:\r?\n|$)/gm, "")
    .trimEnd();
  return `${withoutEmpty}${withoutEmpty ? "\n" : ""}AIHUB_API_KEY=${bundled}\n`;
}
