import { existsSync } from "fs";
import {
  copyFile,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";

export interface PresetContentInstallResult {
  skillsCopied: number;
  templatesCopied: number;
}

async function copyDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = join(source, entry.name);
    const targetEntry = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, targetEntry);
    } else if (entry.isSymbolicLink()) {
      await symlink(await readlink(sourceEntry), targetEntry);
    } else if (entry.isFile()) {
      await copyFile(sourceEntry, targetEntry);
    }
  }
}

async function copyMissingDirectories(
  source: string,
  target: string,
): Promise<number> {
  if (!existsSync(source)) return 0;

  await mkdir(target, { recursive: true });
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const destination = join(target, entry.name);
    if (existsSync(destination)) continue;

    // Copy to a sibling staging directory first. A failed or interrupted copy
    // never leaves a partial preset under the user-visible destination name.
    const staging = join(
      target,
      `.jingyuai-preset-${process.pid}-${randomUUID()}`,
    );

    try {
      await copyDirectory(join(source, entry.name), staging);
      await rename(staging, destination);
      copied += 1;
    } catch {
      await rm(staging, { recursive: true, force: true });
      // Continue installing the remaining independent preset entries.
    }
  }
  return copied;
}

/**
 * Merge content selected by the package builder into the default profile.
 * Existing same-name skills/templates are user-owned and are never replaced.
 */
export async function installPackagedPresetContent(
  presetRoot: string,
  hermesHome: string,
): Promise<PresetContentInstallResult> {
  return {
    skillsCopied: await copyMissingDirectories(
      join(presetRoot, "skills", "custom"),
      join(hermesHome, "skills", "custom"),
    ),
    templatesCopied: await copyMissingDirectories(
      join(presetRoot, "writing-templates"),
      join(hermesHome, "writing-templates"),
    ),
  };
}
