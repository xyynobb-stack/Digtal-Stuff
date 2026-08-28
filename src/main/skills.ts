import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { homedir } from "os";
import {
  HERMES_HOME,
  HERMES_PYTHON,
  HERMES_REPO,
  hermesCliArgs,
  getEnhancedPath,
} from "./installer";
import { isValidNamedProfileName, profileHome } from "./utils";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";

export interface InstalledSkill {
  name: string;
  /** Optional user-facing label from metadata.hermes.display_name. */
  displayName?: string;
  category: string;
  description: string;
  path: string;
  /** Ownership boundary used by the renderer; system Skills stay unchanged. */
  userAdded?: boolean;
}

export interface SkillSearchResult {
  name: string;
  description: string;
  category: string;
  source: string;
  installed: boolean;
}

const USER_ADDED_SKILL_MARKER = ".hermes-desktop-user-added";

/** Mark a copied/installed skill as one the employee explicitly added. */
export function markSkillAsUserAdded(skillPath: string): void {
  writeFileSync(join(skillPath, USER_ADDED_SKILL_MARKER), "", "utf-8");
}

/**
 * Parse SKILL.md frontmatter (YAML between --- markers) for name/description.
 */
function parseSkillFrontmatter(content: string): {
  name: string;
  description: string;
  displayName: string;
} {
  const result = { name: "", description: "", displayName: "" };

  // Check for YAML frontmatter
  if (!content.startsWith("---")) {
    // Fall back to first heading and first paragraph
    const headingMatch = content.match(/^#\s+(.+)/m);
    if (headingMatch) result.name = headingMatch[1].trim();
    const paraMatch = content.match(/^(?!#)(?!---).+/m);
    if (paraMatch) result.description = paraMatch[0].trim().slice(0, 120);
    return result;
  }

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) return result;

  const frontmatter = content.slice(3, endIdx);

  const nameMatch = frontmatter.match(/^\s*name:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (nameMatch) result.name = nameMatch[1].trim();

  const descMatch = frontmatter.match(
    /^\s*description:\s*["']?([^"'\n]+)["']?\s*$/m,
  );
  if (descMatch) result.description = descMatch[1].trim();

  // `display_name` is deliberately optional and namespaced. Third-party
  // Skills that only provide the standard name/description fields therefore
  // remain fully compatible, while employee-created Skills can carry a
  // Unicode label without changing their stable invocation name.
  const lines = frontmatter.split(/\r?\n/);
  let metadataIndent = -1;
  let hermesIndent = -1;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (metadataIndent < 0) {
      if (indent === 0 && /^metadata:\s*$/.test(trimmed)) {
        metadataIndent = indent;
      }
      continue;
    }

    if (indent <= metadataIndent) break;
    if (hermesIndent < 0) {
      if (indent > metadataIndent && /^hermes:\s*$/.test(trimmed)) {
        hermesIndent = indent;
      }
      continue;
    }

    if (indent <= hermesIndent) {
      hermesIndent = -1;
      if (indent > metadataIndent && /^hermes:\s*$/.test(trimmed)) {
        hermesIndent = indent;
      }
      continue;
    }

    const displayNameMatch = trimmed.match(/^display_name:\s*(.*?)\s*$/);
    if (!displayNameMatch) continue;
    let value = displayNameMatch[1].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1).trim();
    }
    // Ignore block scalars, empty values, and unreasonable UI labels rather
    // than rejecting the entire Skill.
    if (value && value !== "|" && value !== ">" && value.length <= 80) {
      result.displayName = value;
    }
    break;
  }

  return result;
}

/**
 * Walk the skills directory to find all installed skills.
 * Structure: skills/<category>/<skill-name>/SKILL.md
 */
export function listInstalledSkills(profile?: string): InstalledSkill[] {
  const skillsDir = join(profileHome(profile), "skills");
  if (!existsSync(skillsDir)) return [];

  const skills: InstalledSkill[] = [];

  try {
    const categories = readdirSync(skillsDir);

    for (const category of categories) {
      const categoryPath = join(skillsDir, category);
      if (!statSync(categoryPath).isDirectory()) continue;

      const entries = readdirSync(categoryPath);
      for (const entry of entries) {
        const entryPath = join(categoryPath, entry);
        if (!statSync(entryPath).isDirectory()) continue;

        const skillFile = join(entryPath, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        try {
          const content = readFileSync(skillFile, "utf-8").slice(0, 4000);
          const meta = parseSkillFrontmatter(content);
          const userAdded =
            category.toLowerCase() === "custom" ||
            existsSync(join(entryPath, USER_ADDED_SKILL_MARKER));

          skills.push({
            name: meta.name || entry,
            ...(userAdded && meta.displayName
              ? { displayName: meta.displayName }
              : {}),
            category,
            description: meta.description || "",
            path: entryPath,
            userAdded,
          });
        } catch {
          const userAdded =
            category.toLowerCase() === "custom" ||
            existsSync(join(entryPath, USER_ADDED_SKILL_MARKER));
          skills.push({
            name: entry,
            category,
            description: "",
            path: entryPath,
            userAdded,
          });
        }
      }
    }
  } catch {
    // ignore
  }

  return skills.sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

/**
 * Mark profile-local legacy imports that predate the `custom/` ownership
 * boundary. A local skill is system-owned only when the bundled Agent contains
 * the same category/directory entry; everything else must obey per-chat user
 * activation even if an old import preserved a product-looking category.
 */
export function ensureLegacyUserSkillMarkers(profile?: string): void {
  // Never infer ownership without the bundled inventory. During a first-run
  // install the Agent repo may not exist yet; marking everything at that point
  // would incorrectly hide genuine system skills behind per-chat activation.
  if (!existsSync(join(HERMES_REPO, "skills"))) return;

  for (const skill of listInstalledSkills(profile)) {
    if (existsSync(join(skill.path, USER_ADDED_SKILL_MARKER))) continue;
    const entry = basename(skill.path);
    const bundledSkillFile = join(
      HERMES_REPO,
      "skills",
      skill.category,
      entry,
      "SKILL.md",
    );
    if (existsSync(bundledSkillFile)) continue;
    try {
      markSkillAsUserAdded(skill.path);
    } catch {
      // Best effort: read-only profiles retain their current skills.
    }
  }
}

/** Return only user-added custom skills for the per-chat picker. */
export function listUserAddedSkills(profile?: string): InstalledSkill[] {
  ensureLegacyUserSkillMarkers(profile);
  return listInstalledSkills(profile).filter(
    (skill) =>
      skill.category.toLowerCase() === "custom" ||
      // Imports made by older desktop builds could retain the category from
      // their frontmatter. Keep their marker as a compatibility boundary.
      existsSync(join(skill.path, USER_ADDED_SKILL_MARKER)),
  );
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function isProfileSkillFile(skillFile: string): boolean {
  const profilesRoot = realOrResolved(join(HERMES_HOME, "profiles"));
  if (!pathIsInside(profilesRoot, skillFile)) return false;

  const parts = relative(profilesRoot, skillFile).split(/[\\/]+/);
  return (
    parts.length >= 4 &&
    isValidNamedProfileName(parts[0]) &&
    parts[1] === "skills"
  );
}

function isAllowedSkillFile(skillFile: string): boolean {
  const allowedRoots = [
    join(HERMES_HOME, "skills"),
    join(HERMES_REPO, "skills"),
  ].map(realOrResolved);

  return (
    allowedRoots.some((root) => pathIsInside(root, skillFile)) ||
    isProfileSkillFile(skillFile)
  );
}

/**
 * Get the full content of a SKILL.md for the detail view.
 */
export function getSkillContent(skillPath: string): string {
  if (typeof skillPath !== "string" || skillPath.trim() === "") return "";

  const skillFile = resolve(skillPath, "SKILL.md");
  if (!existsSync(skillFile)) return "";

  try {
    const realSkillFile = realpathSync(skillFile);
    if (!isAllowedSkillFile(realSkillFile)) return "";
    return readFileSync(realSkillFile, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Search the skill registry via the hermes CLI.
 */
export function searchSkills(query: string): SkillSearchResult[] {
  try {
    const output = execFileSync(
      HERMES_PYTHON,
      hermesCliArgs(["skills", "browse", "--query", query, "--json"]),
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
    );

    const text = output.toString().trim();
    if (!text) return [];

    // Try to parse JSON output
    try {
      const results = JSON.parse(text);
      if (Array.isArray(results)) {
        return results.map((r: Record<string, string>) => ({
          name: r.name || "",
          description: r.description || "",
          category: r.category || "",
          source: r.source || "",
          installed: false,
        }));
      }
    } catch {
      // If JSON parsing fails, the CLI may not support --json flag
      // Fall back to listing bundled skills that match
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * List bundled skills from the hermes-agent repo.
 */
export function listBundledSkills(): SkillSearchResult[] {
  const bundledDir = join(HERMES_REPO, "skills");
  if (!existsSync(bundledDir)) return [];

  const skills: SkillSearchResult[] = [];

  try {
    const categories = readdirSync(bundledDir);

    for (const category of categories) {
      const catPath = join(bundledDir, category);
      if (!statSync(catPath).isDirectory()) continue;

      const entries = readdirSync(catPath);
      for (const entry of entries) {
        const entryPath = join(catPath, entry);
        if (!statSync(entryPath).isDirectory()) continue;

        const skillFile = join(entryPath, "SKILL.md");
        if (!existsSync(skillFile)) continue;

        try {
          const content = readFileSync(skillFile, "utf-8").slice(0, 4000);
          const meta = parseSkillFrontmatter(content);

          skills.push({
            name: meta.name || entry,
            description: meta.description || "",
            category,
            source: "bundled",
            installed: false,
          });
        } catch {
          skills.push({
            name: entry,
            description: "",
            category,
            source: "bundled",
            installed: false,
          });
        }
      }
    }
  } catch {
    // ignore
  }

  return skills.sort(
    (a, b) =>
      a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
  );
}

/**
 * Failure markers seen in `hermes skills install/uninstall` stdout when the
 * CLI exits 0 despite the operation having failed. Observed live against
 * Hermes Agent v0.14.0 (2026.5.16) on 2026-05-22:
 *
 *   $ hermes skills install concept-diagram --yes
 *   Resolving 'concept-diagram'...
 *   No exact match for 'concept-diagram'. Did you mean one of these?
 *     concept-diagrams - official/creative/concept-diagrams
 *   $ echo $?    -> 0
 *
 * Without this classifier the desktop would trust the 0 exit and report
 * a successful install, leaving the user with a button that flashed and
 * did nothing (issue #310).
 */
const SKILL_CLI_FAILURE_MARKERS: readonly RegExp[] = [
  /\bNo exact match for\b/,
  /\bNo skill named\b/,
  /^Error:/m,
];

export interface SkillCliResult {
  success: boolean;
  error?: string;
}

export interface ImportLocalSkillResult extends SkillCliResult {
  canceled?: boolean;
  name?: string;
}

/**
 * Install a user-selected local Skill package into the active profile.
 * The selected file must be SKILL.md; its sibling support folders are copied
 * with it so references, scripts, templates, and assets keep working.
 */
export function importLocalSkill(
  skillFile: string,
  profile?: string,
): ImportLocalSkillResult {
  if (basename(skillFile).toLowerCase() !== "skill.md") {
    return { success: false, error: "请选择名为 SKILL.md 的技能入口文件。" };
  }
  if (!existsSync(skillFile) || !statSync(skillFile).isFile()) {
    return { success: false, error: "所选 SKILL.md 不存在或无法读取。" };
  }

  try {
    const content = readFileSync(skillFile, "utf-8");
    const meta = parseSkillFrontmatter(content);
    const rawName = meta.name.trim();
    if (!rawName) {
      return { success: false, error: "SKILL.md 缺少必填的 name 字段。" };
    }

    const safeName = rawName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (!safeName) {
      return { success: false, error: "SKILL 名称无法转换为有效目录名。" };
    }

    // The storage category is the trust boundary: bundled/system Skills live
    // in their product categories and user imports always live in `custom`.
    // Do not trust an uploaded file's frontmatter category for classification.
    const target = join(profileHome(profile), "skills", "custom", safeName);
    if (existsSync(target)) {
      return { success: false, error: `SKILL “${rawName}” 已经添加。` };
    }

    mkdirSync(dirname(target), { recursive: true });
    cpSync(dirname(skillFile), target, { recursive: true, errorOnExist: true });
    markSkillAsUserAdded(target);
    return { success: true, name: rawName };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "导入本地 SKILL 失败。",
    };
  }
}

/**
 * Classify the combined output of `hermes skills install/uninstall` after
 * the subprocess has exited 0. The CLI exits 0 even on resolution failure
 * (issue #310), so the exit code alone is not enough. When a known failure
 * marker is present, surface the message (minus the leading
 * "Resolving '...'" progress line) as `error` so the renderer can display
 * it; otherwise treat the operation as successful.
 *
 * Pure — no I/O, no globals — so it is cheap to unit-test exhaustively.
 */
export function classifySkillCliOutput(
  stdout: string,
  stderr: string = "",
): SkillCliResult {
  const combined = `${stdout}\n${stderr}`;
  if (SKILL_CLI_FAILURE_MARKERS.some((re) => re.test(combined))) {
    return { success: false, error: extractSkillCliMessage(combined) };
  }
  return { success: true };
}

function extractSkillCliMessage(output: string): string {
  // Strip the leading "Resolving '<name>'..." progress line — pure noise
  // for the user. Keep the rest verbatim so suggestions like
  // "Did you mean concept-diagrams" reach the renderer.
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^Resolving '.*'\.\.\.$/.test(l));
  return lines.join("\n").trim() || output.trim();
}

export function installSkill(
  identifier: string,
  profile?: string,
): SkillCliResult {
  const existingPaths = new Set(
    listInstalledSkills(profile).map((skill) => realOrResolved(skill.path)),
  );
  try {
    const args = hermesCliArgs(["skills", "install", identifier, "--yes"]);
    if (profile && profile !== "default") {
      args.splice(process.platform === "win32" ? 2 : 1, 0, "-p", profile);
    }

    const stdout = execFileSync(HERMES_PYTHON, args, {
      cwd: HERMES_REPO,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        HOME: homedir(),
        HERMES_HOME,
      },
      stdio: "pipe",
      timeout: 60000,
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
    // Exit 0 alone is not proof of success — the CLI exits 0 on resolution
    // failure too. Inspect the captured stdout for known failure markers
    // (issue #310).
    const result = classifySkillCliOutput(stdout?.toString() ?? "");
    if (result.success) {
      for (const skill of listInstalledSkills(profile)) {
        if (!existingPaths.has(realOrResolved(skill.path))) {
          markSkillAsUserAdded(skill.path);
        }
      }
    }
    return result;
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const msg = (e.stderr?.toString() || e.message || "").trim();
    return {
      success: false,
      error: msg || e.stdout?.toString()?.trim() || "Install failed.",
    };
  }
}

export function uninstallSkill(name: string, profile?: string): SkillCliResult {
  // Try the CLI first (updates hub lock files, handles complex cases).
  let cliResult: SkillCliResult | undefined;
  try {
    const args = hermesCliArgs(["skills", "uninstall", name, "--yes"]);
    if (profile && profile !== "default") {
      args.splice(process.platform === "win32" ? 2 : 1, 0, "-p", profile);
    }

    const stdout = execFileSync(HERMES_PYTHON, args, {
      cwd: HERMES_REPO,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        HOME: homedir(),
        HERMES_HOME,
      },
      stdio: "pipe",
      timeout: 30000,
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
    cliResult = classifySkillCliOutput(stdout?.toString() ?? "");
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const msg = (e.stderr?.toString() || e.message || "").trim();
    cliResult = {
      success: false,
      error: msg || e.stdout?.toString()?.trim() || "Uninstall failed.",
    };
  }

  // Direct filesystem cleanup: some skills (bundled ones, name-mismatches)
  // aren't found by the CLI's uninstall but still live on disk. Walk the
  // profile skills directory, find the matching skill, and rm -rf it.
  const skillsDir = join(profileHome(profile), "skills");
  if (existsSync(skillsDir)) {
    try {
      for (const category of readdirSync(skillsDir)) {
        const categoryPath = join(skillsDir, category);
        if (!statSync(categoryPath).isDirectory()) continue;
        for (const entry of readdirSync(categoryPath)) {
          const entryPath = join(categoryPath, entry);
          if (!statSync(entryPath).isDirectory()) continue;

          const skillFile = join(entryPath, "SKILL.md");
          if (!existsSync(skillFile)) continue;

          let skillName: string;
          try {
            const content = readFileSync(skillFile, "utf-8").slice(0, 4000);
            skillName = parseSkillFrontmatter(content).name || entry;
          } catch {
            skillName = entry;
          }

          if (skillName === name || entry === name) {
            rmSync(entryPath, { recursive: true, force: true });
            return { success: true };
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return cliResult ?? { success: false, error: "Uninstall failed." };
}
