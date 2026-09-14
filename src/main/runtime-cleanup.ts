import { randomBytes } from "crypto";
import { lstat, readFile, readdir, rename, rm } from "fs/promises";
import { basename, dirname, join, resolve } from "path";

interface ActiveRuntimePointer {
  version?: unknown;
  repo?: unknown;
}

export interface RuntimeCleanupLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface InactiveRuntimeCleanupOptions {
  managedRoot: string;
  versionsRoot: string;
  currentVersionName: string;
  currentRepo: string;
  logger?: RuntimeCleanupLogger;
}

export interface RuntimeCleanupResult {
  deleted: string[];
  failed: string[];
  skippedReason?: string;
}

const scheduledCleanupKeys = new Set<string>();

function comparablePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSafeDirectChild(root: string, name: string): boolean {
  if (!name || name === "." || name === ".." || basename(name) !== name) {
    return false;
  }
  return comparablePath(dirname(join(root, name))) === comparablePath(root);
}

async function expectedRuntimeIsActive(
  managedRoot: string,
  currentVersionName: string,
  currentRepo: string,
): Promise<boolean> {
  try {
    const pointer = JSON.parse(
      await readFile(join(managedRoot, "active-runtime.json"), "utf8"),
    ) as ActiveRuntimePointer;
    return (
      pointer.version === currentVersionName &&
      typeof pointer.repo === "string" &&
      comparablePath(pointer.repo) === comparablePath(currentRepo)
    );
  } catch {
    return false;
  }
}

/**
 * Remove every inactive immutable Runtime directory after the newly packaged
 * Runtime has been activated. A locked historical tree must never turn a
 * healthy desktop startup into an installation failure.
 */
// @lat: [[main-process#Offline Windows runtime#Inactive Runtime reclamation]]
export async function cleanupInactiveRuntimeVersions({
  managedRoot,
  versionsRoot,
  currentVersionName,
  currentRepo,
  logger = console,
}: InactiveRuntimeCleanupOptions): Promise<RuntimeCleanupResult> {
  const result: RuntimeCleanupResult = { deleted: [], failed: [] };
  if (!isSafeDirectChild(versionsRoot, currentVersionName)) {
    result.skippedReason = "unsafe current Runtime directory name";
    return result;
  }
  if (
    comparablePath(currentRepo) !==
    comparablePath(join(versionsRoot, currentVersionName, "hermes-agent"))
  ) {
    result.skippedReason =
      "current Runtime path is outside its version directory";
    return result;
  }
  if (
    !(await expectedRuntimeIsActive(
      managedRoot,
      currentVersionName,
      currentRepo,
    ))
  ) {
    result.skippedReason = "active Runtime pointer does not match this package";
    return result;
  }

  let entries;
  try {
    entries = await readdir(versionsRoot, { withFileTypes: true });
  } catch (error) {
    result.skippedReason = `could not enumerate Runtime versions: ${error instanceof Error ? error.message : String(error)}`;
    return result;
  }

  for (const entry of entries) {
    if (entry.name === currentVersionName || !entry.isDirectory()) continue;
    if (!isSafeDirectChild(versionsRoot, entry.name)) continue;

    const candidate = join(versionsRoot, entry.name);
    try {
      // Junctions and symbolic links are never recursive-cleanup candidates.
      if ((await lstat(candidate)).isSymbolicLink()) continue;
    } catch {
      continue;
    }

    // Re-read the pointer before each destructive operation. If another
    // installation activated a different version, stop instead of guessing.
    if (
      !(await expectedRuntimeIsActive(
        managedRoot,
        currentVersionName,
        currentRepo,
      ))
    ) {
      result.skippedReason = "active Runtime changed while cleanup was running";
      break;
    }

    let deletionTarget = candidate;
    if (!entry.name.startsWith(".deleting-")) {
      deletionTarget = join(
        versionsRoot,
        `.deleting-${entry.name}-${randomBytes(4).toString("hex")}`,
      );
      try {
        await rename(candidate, deletionTarget);
      } catch (error) {
        result.failed.push(entry.name);
        logger.warn(
          `[runtime-cleanup] Could not quarantine ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    try {
      await rm(deletionTarget, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 500,
      });
      result.deleted.push(entry.name);
    } catch (error) {
      result.failed.push(entry.name);
      logger.warn(
        `[runtime-cleanup] Could not remove ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (result.deleted.length > 0) {
    logger.info(
      `[runtime-cleanup] Removed ${result.deleted.length} inactive Runtime version(s).`,
    );
  }
  return result;
}

/** Queue reclamation outside the install-check critical path. */
export function scheduleInactiveRuntimeCleanup(
  options: InactiveRuntimeCleanupOptions,
  delayMs = 10_000,
): () => void {
  const key = `${comparablePath(options.versionsRoot)}|${options.currentVersionName}`;
  if (scheduledCleanupKeys.has(key)) return () => undefined;
  scheduledCleanupKeys.add(key);
  let started = false;

  const timer = setTimeout(
    () => {
      started = true;
      void cleanupInactiveRuntimeVersions(options)
        .catch((error) => {
          (options.logger ?? console).warn(
            `[runtime-cleanup] Unexpected cleanup failure: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => scheduledCleanupKeys.delete(key));
    },
    Math.max(0, delayMs),
  );
  timer.unref?.();
  return () => {
    if (started) return;
    clearTimeout(timer);
    scheduledCleanupKeys.delete(key);
  };
}
