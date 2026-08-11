import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "fs";
import { join } from "path";

export interface PresetContentInstallResult {
  skillsCopied: number;
  templatesCopied: number;
}

function copyMissingDirectories(source: string, target: string): number {
  if (!existsSync(source)) return 0;

  mkdirSync(target, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const destination = join(target, entry.name);
    if (existsSync(destination)) continue;

    try {
      cpSync(join(source, entry.name), destination, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      copied += 1;
    } catch {
      rmSync(destination, { recursive: true, force: true });
      // Continue installing the remaining independent preset entries.
    }
  }
  return copied;
}

/**
 * Merge content selected by the package builder into the default profile.
 * Existing same-name skills/templates are user-owned and are never replaced.
 */
export function installPackagedPresetContent(
  presetRoot: string,
  hermesHome: string,
): PresetContentInstallResult {
  return {
    skillsCopied: copyMissingDirectories(
      join(presetRoot, "skills", "custom"),
      join(hermesHome, "skills", "custom"),
    ),
    templatesCopied: copyMissingDirectories(
      join(presetRoot, "writing-templates"),
      join(hermesHome, "writing-templates"),
    ),
  };
}
