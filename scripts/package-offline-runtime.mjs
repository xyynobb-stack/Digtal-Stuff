import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { c as createTar, t as listTar } from "tar";

export const RUNTIME_ARCHIVE_NAME = "runtime.tar";
export const RUNTIME_ARCHIVE_MANIFEST_NAME = "runtime-archive.json";
export const RUNTIME_BUILD_MARKER_NAME = "desktop-runtime-build.json";

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

/** Refuse to package a Desktop Agent whose implicit toolsets drop Skills. */
export function verifyDesktopSkillToolsetRuntime(runtimeRoot) {
  const gatewayPath = path.join(
    runtimeRoot,
    "hermes-agent",
    "tui_gateway",
    "server.py",
  );
  if (!fs.existsSync(gatewayPath)) {
    throw new Error(`Desktop gateway source is missing: ${gatewayPath}`);
  }
  const source = fs.readFileSync(gatewayPath, "utf8");
  for (const marker of [
    'return sorted({*selection, "project", "skills"})',
    'return sorted(enabled | {"project", "skills"})',
  ]) {
    if (!source.includes(marker)) {
      throw new Error(
        "Desktop gateway is missing the required Skills toolset overlay",
      );
    }
  }
}

/** Package every staged Runtime entry into one opaque payload for NSIS. */
// @lat: [[main-process#Offline Windows runtime#Single Runtime archive]]
export async function packageOfflineRuntime({ runtimeRoot, packageRoot }) {
  const resolvedRuntimeRoot = path.resolve(runtimeRoot);
  const resolvedPackageRoot = path.resolve(packageRoot);
  const buildMarker = path.join(resolvedRuntimeRoot, RUNTIME_BUILD_MARKER_NAME);
  if (!fs.existsSync(buildMarker)) {
    throw new Error(`Runtime build marker is missing: ${buildMarker}`);
  }
  verifyDesktopSkillToolsetRuntime(resolvedRuntimeRoot);

  const entries = fs
    .readdirSync(resolvedRuntimeRoot)
    .filter((entry) => entry !== path.basename(resolvedPackageRoot))
    .sort();
  if (entries.length === 0) {
    throw new Error(
      `Runtime staging directory is empty: ${resolvedRuntimeRoot}`,
    );
  }

  fs.rmSync(resolvedPackageRoot, { recursive: true, force: true });
  fs.mkdirSync(resolvedPackageRoot, { recursive: true });
  const archivePath = path.join(resolvedPackageRoot, RUNTIME_ARCHIVE_NAME);
  await createTar(
    {
      cwd: resolvedRuntimeRoot,
      file: archivePath,
      portable: true,
      noMtime: true,
      sync: false,
    },
    entries,
  );

  const archiveStat = fs.statSync(archivePath);
  const manifest = {
    schemaVersion: 1,
    archive: RUNTIME_ARCHIVE_NAME,
    bytes: archiveStat.size,
    sha256: sha256File(archivePath),
  };
  fs.copyFileSync(
    buildMarker,
    path.join(resolvedPackageRoot, RUNTIME_BUILD_MARKER_NAME),
  );
  fs.writeFileSync(
    path.join(resolvedPackageRoot, RUNTIME_ARCHIVE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return { archivePath, manifest };
}

/** Verify the sidecar and required entries without expanding the archive. */
export async function verifyOfflineRuntimePackage(packageRoot) {
  const resolvedPackageRoot = path.resolve(packageRoot);
  const manifestPath = path.join(
    resolvedPackageRoot,
    RUNTIME_ARCHIVE_MANIFEST_NAME,
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1 ||
    manifest.archive !== RUNTIME_ARCHIVE_NAME ||
    !Number.isSafeInteger(manifest.bytes) ||
    !/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ""))
  ) {
    throw new Error(`Invalid Runtime archive manifest: ${manifestPath}`);
  }
  const archivePath = path.join(resolvedPackageRoot, manifest.archive);
  const stat = fs.statSync(archivePath);
  if (
    stat.size !== manifest.bytes ||
    sha256File(archivePath) !== manifest.sha256
  ) {
    throw new Error("Runtime archive size or checksum verification failed");
  }
  const entries = new Set();
  await listTar({
    file: archivePath,
    onentry: (entry) => entries.add(entry.path.replace(/\\/g, "/")),
  });
  const required = [
    "hermes-agent/run_agent.py",
    "hermes-agent/hermes_cli/web_dist/index.html",
    "hermes-agent/venv/Scripts/python.exe",
    "hermes-agent/venv/Scripts/hermes.exe",
    "python-runtime/python.exe",
    "python-runtime/DLLs/sqlite3.dll",
    "python-runtime/desktop-sqlite-runtime.json",
    "git/bin/bash.exe",
    "git/cmd/git.exe",
    "employee-lookup.env",
    RUNTIME_BUILD_MARKER_NAME,
  ];
  const missing = required.filter((entry) => !entries.has(entry));
  if (missing.length > 0) {
    throw new Error(`Runtime archive is incomplete: ${missing.join(", ")}`);
  }
  return { archivePath, entries, manifest };
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const defaultRuntimeRoot = path.join(projectRoot, "build", "offline-runtime");
const defaultPackageRoot = path.join(
  projectRoot,
  "build",
  "offline-runtime-package",
);

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  if (process.argv[2] === "--verify") {
    const result = await verifyOfflineRuntimePackage(
      process.argv[3] ||
        process.env.HERMES_RUNTIME_PACKAGE ||
        defaultPackageRoot,
    );
    console.log(
      `Verified Runtime archive: ${result.archivePath} (${result.manifest.bytes} bytes, ${result.entries.size} entries)`,
    );
  } else {
    const result = await packageOfflineRuntime({
      runtimeRoot: process.env.HERMES_RUNTIME_SOURCE || defaultRuntimeRoot,
      packageRoot: process.env.HERMES_RUNTIME_PACKAGE || defaultPackageRoot,
    });
    console.log(
      `Packaged Runtime archive: ${result.archivePath} (${result.manifest.bytes} bytes, sha256=${result.manifest.sha256})`,
    );
  }
}
