import Database from "better-sqlite3";
import { existsSync } from "fs";
import { activeStateDbPath } from "./utils";

let cachedDb: Database.Database | null = null;
let cachedDbPath: string | null = null;
let cachedDbReadonly: boolean | null = null;
let connectionsSuspended = false;

/**
 * Return a cached database connection for the active profile state DB.
 * If the active profile database path or readonly status changes,
 * the old database connection is cleanly closed and a new one is established.
 */
export function getDbConnection(readonly = true): Database.Database | null {
  if (connectionsSuspended) return null;
  const dbPath = activeStateDbPath();
  if (!existsSync(dbPath)) {
    closeDbConnection();
    return null;
  }

  // Reuse the existing cached connection if the path and mode match
  if (cachedDb && cachedDbPath === dbPath && cachedDbReadonly === readonly) {
    return cachedDb;
  }

  closeDbConnection();

  try {
    cachedDb = new Database(dbPath, readonly ? { readonly: true } : {});
    cachedDbPath = dbPath;
    cachedDbReadonly = readonly;
    return cachedDb;
  } catch (err) {
    console.error(`[db] Failed to open database at ${dbPath}:`, err);
    return null;
  }
}

/**
 * Prevent renderer-driven session reads from reopening state.db while an
 * employee continuity migration atomically replaces the active Profile DB.
 */
export function setDbConnectionsSuspended(suspended: boolean): void {
  connectionsSuspended = suspended;
  if (suspended) closeDbConnection();
}

/**
 * Close the cached database connection if open.
 */
export function closeDbConnection(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch (err) {
      console.error("[db] Error closing database connection:", err);
    }
    cachedDb = null;
    cachedDbPath = null;
    cachedDbReadonly = null;
  }
}
