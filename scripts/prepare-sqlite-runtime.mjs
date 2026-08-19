import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SQLITE_RUNTIME_VERSION = "3.53.4";
export const SQLITE_RUNTIME_BUILD = "3530400";
export const SQLITE_RUNTIME_SHA3_256 =
  "deddee963c810d1eeac3ce5e15c7c41da21a1c54d7a39cf54fbf577d2f50de3a";

export function sqliteRuntimeAssetName(arch = process.arch) {
  if (arch !== "x64") {
    throw new Error(
      `Bundled SQLite is not configured for architecture: ${arch}`,
    );
  }
  return `sqlite-dll-win-x64-${SQLITE_RUNTIME_BUILD}.zip`;
}

export function sqliteRuntimeDownloadUrl(arch = process.arch) {
  return `https://www.sqlite.org/2026/${sqliteRuntimeAssetName(arch)}`;
}

export function sha3_256(value) {
  return createHash("sha3-256").update(value).digest("hex");
}

async function download(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.log(`SQLite download attempt ${attempt} failed; retrying...`);
      }
    }
  }
  throw new Error(`SQLite runtime download failed: ${lastError}`);
}

function verifyRuntime(runtimeRoot) {
  const runtimePython = path.join(runtimeRoot, "python.exe");
  const probe = `
import os
import sqlite3
import tempfile

assert sqlite3.sqlite_version == "${SQLITE_RUNTIME_VERSION}", sqlite3.sqlite_version
fd, db_path = tempfile.mkstemp(prefix="jingyuai-sqlite-", suffix=".db")
os.close(fd)
try:
    connection = sqlite3.connect(db_path)
    try:
        mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
        assert mode.lower() == "wal", mode
        connection.execute("CREATE VIRTUAL TABLE probe_fts USING fts5(content)")
    finally:
        connection.close()
finally:
    for suffix in ("", "-wal", "-shm"):
        try:
            os.remove(db_path + suffix)
        except FileNotFoundError:
            pass
print(sqlite3.sqlite_version)
`;
  const result = spawnSync(runtimePython, ["-c", probe], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Bundled SQLite verification failed: ${
        result.error || result.stderr || `Python exited ${result.status}`
      }`,
    );
  }
}

export async function prepareSqliteRuntime({
  runtimeRoot = path.resolve(
    import.meta.dirname,
    "..",
    "build",
    "offline-runtime",
    "python-runtime",
  ),
  arch = process.arch,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("Bundled SQLite staging is supported only on Windows");
  }

  const runtimePython = path.join(runtimeRoot, "python.exe");
  const runtimeDll = path.join(runtimeRoot, "DLLs", "sqlite3.dll");
  if (
    !fs.existsSync(runtimePython) ||
    !fs.existsSync(path.dirname(runtimeDll))
  ) {
    throw new Error(`Bundled Python runtime is incomplete: ${runtimeRoot}`);
  }

  const asset = sqliteRuntimeAssetName(arch);
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "jingyuai-sqlite-runtime-"),
  );
  const archive = path.join(temporaryRoot, asset);
  const extractedRoot = path.join(temporaryRoot, "extracted");

  try {
    const url = sqliteRuntimeDownloadUrl(arch);
    console.log(`Downloading ${url}`);
    await download(url, archive);

    const actualHash = sha3_256(fs.readFileSync(archive));
    if (actualHash !== SQLITE_RUNTIME_SHA3_256) {
      throw new Error(
        `SQLite archive SHA3-256 mismatch: expected ${SQLITE_RUNTIME_SHA3_256}, got ${actualHash}`,
      );
    }

    fs.mkdirSync(extractedRoot, { recursive: true });
    const extraction = spawnSync(
      "tar.exe",
      ["-xf", archive, "-C", extractedRoot],
      { stdio: "inherit", windowsHide: true },
    );
    if (extraction.error || extraction.status !== 0) {
      throw (
        extraction.error ||
        new Error(`SQLite archive extraction exited ${extraction.status}`)
      );
    }

    const extractedDll = path.join(extractedRoot, "sqlite3.dll");
    if (!fs.existsSync(extractedDll)) {
      throw new Error(`SQLite archive is incomplete: ${asset}`);
    }
    fs.copyFileSync(extractedDll, runtimeDll);
    verifyRuntime(runtimeRoot);
    fs.writeFileSync(
      path.join(runtimeRoot, "desktop-sqlite-runtime.json"),
      `${JSON.stringify(
        {
          version: SQLITE_RUNTIME_VERSION,
          arch,
          asset,
          sha3_256: SQLITE_RUNTIME_SHA3_256,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`SQLite ${SQLITE_RUNTIME_VERSION} staged at ${runtimeDll}`);
    return runtimeDll;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await prepareSqliteRuntime();
