import { app } from "electron";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

export function redactInstallCheckText(text: string): string {
  let result = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (
      /key|token|secret|password|authorization/i.test(name) &&
      value &&
      value.length >= 6
    ) {
      result = result.split(value).join("[REDACTED]");
    }
  }
  return result
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(
      /((?:[\w-]*(?:key|token|secret|password)[\w-]*)["']?\s*[:=]\s*)[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/https?:\/\/[^\s"']+/gi, "[URL REDACTED]")
    .slice(0, 4000);
}

/** Best-effort local diagnostics only; never block or change installation. */
export function recordInstallCheck(
  stage: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  try {
    const safe = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        typeof value === "string" ? redactInstallCheckText(value) : value,
      ]),
    );
    const directory = app.getPath("userData");
    mkdirSync(directory, { recursive: true });
    appendFileSync(
      join(directory, "install-check.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        version: app.getVersion(),
        stage,
        ...safe,
      }) + "\n",
    );
  } catch {
    // Logging must not turn a successful check or OAuth request into a failure.
  }
}
