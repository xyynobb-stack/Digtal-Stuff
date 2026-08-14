import path from "node:path";

const EXCLUDED_AT_ANY_DEPTH = new Set([
  ".git",
  "node_modules",
  "tests",
  "tests-js",
  "docs",
  "website",
  "contributors",
  "__pycache__",
]);

const EXCLUDED_AT_REPOSITORY_ROOT = new Set(["assets"]);

/**
 * Keep nested runtime assets while excluding heavyweight repository-only
 * content. In particular, `hermes_cli/web_dist/assets` is executable
 * Dashboard output and must not be confused with the Agent repository's
 * top-level `assets` directory.
 */
// @lat: [[desktop-updates#Bundled runtime updates]]
export function shouldCopyAgentRuntimeEntry(sourceRepo, candidatePath) {
  const relative = path.relative(sourceRepo, candidatePath);
  if (!relative) return true;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  if (EXCLUDED_AT_ANY_DEPTH.has(path.basename(candidatePath))) return false;
  return !EXCLUDED_AT_REPOSITORY_ROOT.has(relative);
}
