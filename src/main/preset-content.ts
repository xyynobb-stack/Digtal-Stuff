import { createHash, randomUUID } from "crypto";
import { existsSync } from "fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { dirname, join, relative } from "path";

export interface PresetContentInstallResult {
  skillsCopied: number;
  templatesCopied: number;
}

const MANAGED_USER_SKILLS = [
  "market-report-rag",
  "hr-analysis-report-rag",
  "finance-analysis-report-rag",
  "skill-creator",
] as const;
// Keep the existing marker filename so report Skills installed by earlier
// releases retain their revision history when Skill Creator joins this set.
const MANAGED_SKILL_REVISION_FILE = ".jingyuai-managed-report-revision";

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

async function calculateDirectoryRevision(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        entry.name === MANAGED_SKILL_REVISION_FILE ||
        entry.name === ".hermes-desktop-user-added" ||
        entry.name === "__pycache__"
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      hash.update(`${entry.isDirectory() ? "d" : "f"}:${relativePath}\0`);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isSymbolicLink()) {
        hash.update(await readlink(path));
      } else if (entry.isFile()) {
        hash.update(await readFile(path));
      }
    }
  }

  await visit(root);
  return hash.digest("hex");
}

async function replaceManagedDirectory(
  source: string,
  destination: string,
  backupRoot: string,
  name: string,
): Promise<boolean> {
  if (!existsSync(source)) return false;

  const revision = await calculateDirectoryRevision(source);
  if (existsSync(destination)) {
    try {
      const installedRevision = await readFile(
        join(destination, MANAGED_SKILL_REVISION_FILE),
        "utf8",
      );
      if (installedRevision.trim() === revision) return false;
    } catch {
      // A pre-managed installation has no revision marker and is upgraded once.
    }
  }

  await mkdir(dirname(destination), { recursive: true });
  const staging = join(
    dirname(destination),
    `.jingyuai-managed-${process.pid}-${randomUUID()}`,
  );
  let backup = "";
  try {
    await copyDirectory(source, staging);
    await writeFile(
      join(staging, MANAGED_SKILL_REVISION_FILE),
      `${revision}\n`,
      "utf8",
    );
    if (existsSync(destination)) {
      await mkdir(backupRoot, { recursive: true });
      backup = join(backupRoot, `previous-custom-${name}-${randomUUID()}`);
      await rename(destination, backup);
    }
    await rename(staging, destination);
    return true;
  } catch {
    await rm(staging, { recursive: true, force: true });
    if (backup && !existsSync(destination) && existsSync(backup)) {
      try {
        await rename(backup, destination);
      } catch {
        // Preserve the backup for manual recovery if restoration also fails.
      }
    }
    return false;
  }
}

/** Refresh product-maintained user Skills while preserving the old copy. */
export async function installManagedUserSkills(
  presetRoot: string,
  hermesHome: string,
): Promise<number> {
  const sourceRoot = join(presetRoot, "skills", "custom");
  const targetRoot = join(hermesHome, "skills", "custom");
  const backupRoot = join(hermesHome, "skill-backups");
  let installed = 0;
  for (const name of MANAGED_USER_SKILLS) {
    if (
      await replaceManagedDirectory(
        join(sourceRoot, name),
        join(targetRoot, name),
        backupRoot,
        name,
      )
    ) {
      installed += 1;
    }
  }
  return installed;
}

/**
 * Move the obsolete product-owned research copy out of the Agent scan roots.
 * Older desktop builds installed market-report-rag under research; current
 * builds install the maintained editable copy under custom. Keeping both makes
 * skill_view reject the bare name as ambiguous. The backup preserves any local
 * edits while ensuring only the canonical custom copy remains discoverable.
 */
export async function quarantineLegacyMarketReportSkill(
  hermesHome: string,
): Promise<string | null> {
  const legacy = join(hermesHome, "skills", "research", "market-report-rag");
  const canonical = join(hermesHome, "skills", "custom", "market-report-rag");
  if (!existsSync(legacy) || !existsSync(canonical)) return null;

  try {
    const backupRoot = join(hermesHome, "skill-backups");
    await mkdir(backupRoot, { recursive: true });
    const backup = join(
      backupRoot,
      `legacy-research-market-report-rag-${randomUUID()}`,
    );
    await rename(legacy, backup);
    return backup;
  } catch {
    return null;
  }
}

/**
 * Merge content selected by the package builder into the default profile.
 * Maintained user Skills use revisioned upgrades with recoverable backups;
 * all other same-name skills and templates remain user-owned and untouched.
 */
export async function installPackagedPresetContent(
  presetRoot: string,
  hermesHome: string,
): Promise<PresetContentInstallResult> {
  const managedSkillsCopied = await installManagedUserSkills(
    presetRoot,
    hermesHome,
  );
  const otherSkillsCopied = await copyMissingDirectories(
    join(presetRoot, "skills", "custom"),
    join(hermesHome, "skills", "custom"),
  );
  const skillsCopied = managedSkillsCopied + otherSkillsCopied;
  await quarantineLegacyMarketReportSkill(hermesHome);
  const templatesCopied = await copyMissingDirectories(
    join(presetRoot, "writing-templates"),
    join(hermesHome, "writing-templates"),
  );
  return { skillsCopied, templatesCopied };
}
