import { spawn, execFile, execFileSync } from "child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { cp } from "fs/promises";
import { join, delimiter, dirname, posix, resolve, sep, win32 } from "path";
import { homedir, tmpdir } from "os";
import { createHash, randomBytes } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import { x as extractTar } from "tar";
import { app, type BrowserWindow } from "electron";
import {
  getConnectionConfig,
  getModelConfig,
  hasOAuthCredentials,
} from "./config";
import { providerDoesNotNeedApiKey } from "./providers";
import { getActiveProfileNameSync, profileHome, stripAnsi } from "./utils";
import { setupAskpass, AskpassHandle } from "./askpass";
import { precacheSudoCredentials } from "./sudoCreds";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import {
  installManagedUserSkillsFromDirectory,
  installPackagedPresetContent,
} from "./preset-content";
import { mergeBundledEmployeeLookupToken } from "./employee-lookup-token";
import { mergeBundledAihubKey } from "./managed-aihub-key";
import {
  desktopRuntimeBuildIdentity,
  desktopRuntimeVersionName,
} from "./runtime-build";
import { recordColdStartTiming } from "./cold-start-timing";

const IS_WINDOWS = process.platform === "win32";
const RUNTIME_ARCHIVE_NAME = "runtime.tar";
const RUNTIME_ARCHIVE_MANIFEST_NAME = "runtime-archive.json";

interface RuntimeArchiveManifest {
  archive: string;
  bytes: number;
  schemaVersion: number;
  sha256: string;
}

function readRuntimeArchiveManifest(
  sourceRoot: string,
): RuntimeArchiveManifest {
  const manifestPath = join(sourceRoot, RUNTIME_ARCHIVE_MANIFEST_NAME);
  const raw = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as Partial<RuntimeArchiveManifest>;
  if (
    raw.schemaVersion !== 1 ||
    raw.archive !== RUNTIME_ARCHIVE_NAME ||
    !Number.isSafeInteger(raw.bytes) ||
    Number(raw.bytes) <= 0 ||
    typeof raw.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(raw.sha256)
  ) {
    throw new Error("packaged Runtime archive manifest is invalid");
  }
  return raw as RuntimeArchiveManifest;
}

function safeRuntimeArchiveEntry(entryPath: string): boolean {
  const normalized = entryPath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

/** Stream one verified archive directly into the immutable staging tree. */
export async function extractBundledRuntimeArchive(
  sourceRoot: string,
  stagingRoot: string,
): Promise<void> {
  const manifest = readRuntimeArchiveManifest(sourceRoot);
  const archivePath = join(sourceRoot, manifest.archive);
  const archiveStat = statSync(archivePath);
  if (!archiveStat.isFile() || archiveStat.size !== manifest.bytes) {
    throw new Error(
      "packaged Runtime archive size does not match its manifest",
    );
  }
  mkdirSync(stagingRoot, { recursive: true });
  const hash = createHash("sha256");
  const hashStream = new Transform({
    transform(chunk: Buffer, _encoding, callback): void {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(
    createReadStream(archivePath),
    hashStream,
    extractTar({
      cwd: stagingRoot,
      preservePaths: false,
      strict: true,
      filter: (entryPath) => {
        if (!safeRuntimeArchiveEntry(entryPath)) {
          throw new Error(`unsafe Runtime archive entry: ${entryPath}`);
        }
        return true;
      },
    }),
  );
  const actualHash = hash.digest("hex");
  if (actualHash.toLowerCase() !== manifest.sha256.toLowerCase()) {
    throw new Error(
      "packaged Runtime archive checksum does not match its manifest",
    );
  }
}

/**
 * Paths inside the relocatable Python runtime bundled with an offline build.
 * Windows ships the embeddable interpreter at the runtime root, whereas the
 * macOS standalone distribution follows the conventional `bin/python3`
 * layout. Keeping this in one helper prevents a macOS package from receiving
 * a Windows-only `python.exe` path in its repaired virtual-environment file.
 */
export function bundledPythonRuntimeLayout(
  runtimeRoot: string,
  platform = process.platform,
): { home: string; executable: string; launcherDirectory: string } {
  const platformPath = platform === "win32" ? win32 : posix;
  if (platform === "win32") {
    return {
      home: runtimeRoot,
      executable: platformPath.join(runtimeRoot, "python.exe"),
      launcherDirectory: "Scripts",
    };
  }
  return {
    home: platformPath.join(runtimeRoot, "bin"),
    executable: platformPath.join(runtimeRoot, "bin", "python3"),
    launcherDirectory: "bin",
  };
}

/**
 * Repair the import path for a relocated Windows offline venv.
 *
 * CI builds the managed Agent with an editable install, whose generated
 * finder contains absolute paths to the CI checkout. A `.pth` entry pointing
 * at the writable runtime repo keeps every venv subprocess importable after
 * relocation, including processes that intentionally use a neutral cwd.
 */
export function repairBundledPythonImportPath(
  runtimeRepo: string,
  platform = process.platform,
): string | null {
  if (platform !== "win32" || !runtimeRepo) return null;
  const sitePackages = join(runtimeRepo, "venv", "Lib", "site-packages");
  if (!existsSync(sitePackages)) return null;
  const sourcePathFile = join(sitePackages, "jingyu-runtime-root.pth");
  writeFileSync(sourcePathFile, `${resolve(runtimeRepo)}\n`, "utf8");
  return sourcePathFile;
}

/** Locate the complete PortableGit tree shipped beside the offline runtime. */
// @lat: [[desktop-updates#Bundled runtime updates]]
export function bundledPortableGitLayout(
  resourcesRoot: string,
  platform = process.platform,
): { root: string; bash: string; pathEntries: string[] } | null {
  if (platform !== "win32" || !resourcesRoot) return null;
  const root = join(resourcesRoot, "hermes-runtime", "git");
  return {
    root,
    bash: join(root, "bin", "bash.exe"),
    pathEntries: [
      join(root, "bin"),
      join(root, "cmd"),
      join(root, "usr", "bin"),
    ],
  };
}

const HERMES_DESKTOP_USER_DATA_DIR =
  process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim();
if (HERMES_DESKTOP_USER_DATA_DIR) {
  try {
    app.setPath("userData", HERMES_DESKTOP_USER_DATA_DIR);
  } catch {
    /* best effort: Electron may reject late path changes in tests */
  }
}

// Packaged builds carry a complete Hermes/Python runtime as one archive under
// resources/hermes-runtime. Expand it asynchronously into a writable per-user
// location after the first window is created so a large offline runtime never
// blocks (or crashes) Electron while the main-process bundle is being loaded.
//
// A prior package can leave a partial tree in userData. Never repair that tree
// in place: each build gets an immutable version directory, prepared in a
// private sibling and made active only after validation.
export function resolveBundledRuntimeRepo(
  resourcesRoot: string,
  userDataRoot: string,
  packaged: boolean,
  desktopVersion = "",
): string {
  if (!packaged || !resourcesRoot || !userDataRoot) return "";
  const sourceRoot = join(resourcesRoot, "hermes-runtime");
  const sourceRepo = join(sourceRoot, "hermes-agent");
  const sourceArchive = join(sourceRoot, RUNTIME_ARCHIVE_NAME);
  if (existsSync(sourceRepo) || existsSync(sourceArchive)) {
    const markerPath = join(sourceRoot, "desktop-runtime-build.json");
    const marker = existsSync(markerPath)
      ? readFileSync(markerPath, "utf8")
      : "";
    const versionName = desktopRuntimeVersionName(marker, desktopVersion);
    return join(
      userDataRoot,
      "hermes-runtime",
      "versions",
      versionName,
      "hermes-agent",
    );
  }

  const activePointer = join(
    userDataRoot,
    "hermes-runtime",
    "active-runtime.json",
  );
  if (existsSync(activePointer)) {
    try {
      const active = JSON.parse(readFileSync(activePointer, "utf8")) as {
        repo?: unknown;
      };
      if (typeof active.repo === "string" && existsSync(active.repo)) {
        return active.repo;
      }
    } catch {
      // Fall through to the pre-versioned runtime for an older installation.
    }
  }
  const legacyRepo = join(userDataRoot, "hermes-runtime", "hermes-agent");
  return existsSync(legacyRepo) ? legacyRepo : "";
}

function activeRuntimeRepo(managedRoot: string): string {
  const activePointer = join(managedRoot, "active-runtime.json");
  if (!existsSync(activePointer)) return "";
  try {
    const active = JSON.parse(readFileSync(activePointer, "utf8")) as {
      repo?: unknown;
    };
    return typeof active.repo === "string" ? active.repo : "";
  } catch {
    return "";
  }
}

interface ManagedPidFile {
  path: string;
  pid: number;
}

function parseManagedPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const value = raw.startsWith("{")
      ? (JSON.parse(raw) as { pid?: unknown }).pid
      : Number.parseInt(raw, 10);
    return typeof value === "number" && Number.isInteger(value) && value > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

/** PID files owned by desktop gateways/dashboard processes across profiles. */
export function managedRuntimePidFiles(hermesHome: string): ManagedPidFile[] {
  const profileHomes = [hermesHome];
  const profilesRoot = join(hermesHome, "profiles");
  if (existsSync(profilesRoot)) {
    try {
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        if (entry.isDirectory())
          profileHomes.push(join(profilesRoot, entry.name));
      }
    } catch {
      // The runtime process scan below remains the fallback.
    }
  }
  const result: ManagedPidFile[] = [];
  for (const home of profileHomes) {
    for (const filename of ["gateway.pid", "dashboard-desktop.pid"]) {
      const path = join(home, filename);
      const pid = parseManagedPidFile(path);
      if (pid) result.push({ path, pid });
    }
  }
  return result;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function windowsPythonPid(pid: number): boolean {
  try {
    const output = execFileSync(
      "tasklist.exe",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
    return /^"python(?:w)?\.exe"/i.test(output);
  } catch {
    return false;
  }
}

function managedRuntimeProcessPids(runtimeRoot: string): number[] {
  if (!existsSync(runtimeRoot)) return [];
  if (process.platform === "win32") {
    const script = `
$root = [IO.Path]::GetFullPath($env:JINGYU_MANAGED_RUNTIME_ROOT)
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ProcessId -ne $PID -and
    $_.Name -match '^python(w)?\\.exe$' -and
    $_.ExecutablePath -and
    ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith(
      $root,
      [StringComparison]::OrdinalIgnoreCase
    )
  } |
  ForEach-Object { $_.ProcessId }
`;
    try {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...process.env,
            JINGYU_MANAGED_RUNTIME_ROOT: resolve(runtimeRoot),
          },
        },
      );
      return output
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
    } catch {
      return [];
    }
  }

  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    });
    const normalizedRoot = resolve(runtimeRoot);
    return output
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*(\d+)\s+(.+)$/);
        if (!match || !match[2].includes(normalizedRoot)) return 0;
        return /(?:^|[/\s])python(?:\d+(?:\.\d+)*)?(?:\s|$)/i.test(match[2])
          ? Number.parseInt(match[1], 10)
          : 0;
      })
      .filter((pid) => pid > 0 && pid !== process.pid);
  } catch {
    return [];
  }
}

function terminateManagedProcess(pid: number): void {
  if (!processIsAlive(pid)) return;
  if (process.platform === "win32") {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, "SIGTERM");
}

/** Stop stale packaged gateway/dashboard trees before activating a new build. */
export function stopManagedRuntimeProcessesForUpgrade(
  hermesHome: string,
  runtimeRoot: string,
): number[] {
  const pidFiles = managedRuntimePidFiles(hermesHome);
  const discovered = managedRuntimeProcessPids(runtimeRoot);
  const ownedPidFilePids = pidFiles
    .map((entry) => entry.pid)
    .filter(
      (pid) =>
        discovered.includes(pid) ||
        (process.platform === "win32"
          ? windowsPythonPid(pid)
          : processIsAlive(pid)),
    );
  const pids = [...new Set([...discovered, ...ownedPidFilePids])];
  for (const pid of pids) terminateManagedProcess(pid);
  const survivors = pids.filter(processIsAlive);
  if (survivors.length > 0) {
    throw new Error(
      `旧版 gateway/dashboard 进程未能停止: ${survivors.join(", ")}`,
    );
  }
  for (const entry of pidFiles) {
    try {
      unlinkSync(entry.path);
    } catch {
      // A stale marker cannot block the immutable runtime switch.
    }
  }
  return pids;
}

export function validateRuntimeTree(
  runtimeRepo: string,
  pythonRoot: string,
  buildMarker: string,
  expectedBuildIdentity: string,
  sourcePythonExists: boolean,
  requireRelocatedPaths = true,
  platform = process.platform,
): string | null {
  if (platform === "win32" && !sourcePythonExists) {
    return "packaged Python runtime is missing from application resources";
  }
  if (!existsSync(join(runtimeRepo, "tui_gateway", "server.py"))) {
    return "gateway source is missing";
  }
  const launcher =
    platform === "win32"
      ? join(runtimeRepo, "venv", "Scripts", "python.exe")
      : join(runtimeRepo, "venv", "bin", "python");
  if (!existsSync(launcher)) return "Python virtual environment is incomplete";
  const cli =
    platform === "win32"
      ? join(runtimeRepo, "venv", "Scripts", "hermes.exe")
      : join(runtimeRepo, "hermes");
  if (!existsSync(cli)) return "JingYuAI CLI launcher is incomplete";
  if (sourcePythonExists) {
    const { executable, home } = bundledPythonRuntimeLayout(
      pythonRoot,
      platform,
    );
    if (!existsSync(executable)) return "bundled Python executable is missing";
    if (requireRelocatedPaths) {
      const cfg = join(runtimeRepo, "venv", "pyvenv.cfg");
      if (!existsSync(cfg))
        return "Python virtual environment config is missing";
      const config = readFileSync(cfg, "utf8");
      const configuredHome = config.match(/^home\s*=\s*(.+)$/m)?.[1]?.trim();
      const configuredExecutable = config
        .match(/^executable\s*=\s*(.+)$/m)?.[1]
        ?.trim();
      const normalize = (value: string): string =>
        resolve(value)
          .replace(/[\\/]+/g, "/")
          .toLowerCase();
      if (
        !configuredHome ||
        !configuredExecutable ||
        normalize(configuredHome) !== normalize(home) ||
        normalize(configuredExecutable) !== normalize(executable)
      ) {
        return "Python virtual environment points outside the active runtime";
      }
    }
  }
  if (
    !existsSync(buildMarker) ||
    readFileSync(buildMarker, "utf8") !== expectedBuildIdentity
  ) {
    return "runtime build marker does not match the package";
  }
  return null;
}

export function repairRelocatedRuntime(
  runtimeRepo: string,
  pythonRoot: string,
): void {
  const cfg = join(runtimeRepo, "venv", "pyvenv.cfg");
  if (existsSync(cfg) && existsSync(pythonRoot)) {
    const { executable, home } = bundledPythonRuntimeLayout(pythonRoot);
    const text = readFileSync(cfg, "utf-8")
      .replace(/^home\s*=.*$/m, `home = ${home}`)
      .replace(/^executable\s*=.*$/m, `executable = ${executable}`)
      .replace(
        /^command\s*=.*$/m,
        `command = ${executable} -m venv ${join(runtimeRepo, "venv")}`,
      );
    writeFileSync(cfg, text, "utf-8");
  }
  repairBundledPythonImportPath(runtimeRepo);
}

export function probeRelocatedRuntime(runtimeRepo: string): void {
  const launcher =
    process.platform === "win32"
      ? join(runtimeRepo, "venv", "Scripts", "python.exe")
      : join(runtimeRepo, "venv", "bin", "python");
  execFileSync(launcher, ["-c", "import sys; print(sys.executable)"], {
    cwd: runtimeRepo,
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONPATH: runtimeRepo,
    },
  });
}

function activateRuntime(
  managedRoot: string,
  versionName: string,
  targetRepo: string,
  expectedBuildIdentity: string,
): void {
  const activePointer = join(managedRoot, "active-runtime.json");
  const pointerTemp = join(
    managedRoot,
    `.active-runtime-${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(
    pointerTemp,
    `${JSON.stringify(
      {
        version: versionName,
        repo: targetRepo,
        buildIdentity: expectedBuildIdentity,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  renameSync(pointerTemp, activePointer);
}

async function prepareBundledRuntime(): Promise<void> {
  if (!app?.isPackaged) return;
  const sourceRoot = join(process.resourcesPath, "hermes-runtime");
  const managedRoot = join(app.getPath("userData"), "hermes-runtime");
  const sourceRepo = join(sourceRoot, "hermes-agent");
  const sourcePython = join(sourceRoot, "python-runtime");
  const sourceArchive = join(sourceRoot, RUNTIME_ARCHIVE_NAME);
  const sourceBuildMarker = join(sourceRoot, "desktop-runtime-build.json");
  try {
    if (existsSync(sourceArchive) || existsSync(sourceRepo)) {
      const archivedRuntime = existsSync(sourceArchive);
      if (archivedRuntime) readRuntimeArchiveManifest(sourceRoot);
      const packagedBuildMarker = existsSync(sourceBuildMarker)
        ? readFileSync(sourceBuildMarker, "utf8")
        : "";
      const expectedBuildIdentity = desktopRuntimeBuildIdentity(
        packagedBuildMarker,
        app.getVersion(),
      );
      const versionName = desktopRuntimeVersionName(
        packagedBuildMarker,
        app.getVersion(),
      );
      const versionsRoot = join(managedRoot, "versions");
      const versionRoot = join(versionsRoot, versionName);
      const targetRepo = join(versionRoot, "hermes-agent");
      const targetPython = join(versionRoot, "python-runtime");
      const targetBuildMarker = join(versionRoot, "desktop-runtime-build.json");
      let currentError = validateRuntimeTree(
        targetRepo,
        targetPython,
        targetBuildMarker,
        expectedBuildIdentity,
        archivedRuntime || existsSync(sourcePython),
      );
      if (!currentError) {
        try {
          probeRelocatedRuntime(targetRepo);
        } catch (error) {
          currentError = `Python runtime probe failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const activationChanged =
        !activeRuntimeRepo(managedRoot) ||
        resolve(activeRuntimeRepo(managedRoot)) !== resolve(targetRepo);

      if (currentError || activationChanged) {
        stopManagedRuntimeProcessesForUpgrade(HERMES_HOME, managedRoot);
      }

      if (currentError) {
        mkdirSync(versionsRoot, { recursive: true });
        const stagingRoot = join(
          versionsRoot,
          `.staging-${versionName}-${randomBytes(6).toString("hex")}`,
        );
        const stagingRepo = join(stagingRoot, "hermes-agent");
        const stagingPython = join(stagingRoot, "python-runtime");
        const stagingBuildMarker = join(
          stagingRoot,
          "desktop-runtime-build.json",
        );
        try {
          if (archivedRuntime) {
            await extractBundledRuntimeArchive(sourceRoot, stagingRoot);
          } else {
            await cp(sourceRepo, stagingRepo, {
              recursive: true,
              force: false,
            });
            if (existsSync(sourcePython)) {
              await cp(sourcePython, stagingPython, {
                recursive: true,
                force: false,
              });
            }
          }
          writeFileSync(stagingBuildMarker, expectedBuildIdentity, "utf8");
          const stagedError = validateRuntimeTree(
            stagingRepo,
            stagingPython,
            stagingBuildMarker,
            expectedBuildIdentity,
            archivedRuntime || existsSync(sourcePython),
            false,
          );
          if (stagedError) throw new Error(stagedError);

          if (existsSync(versionRoot)) {
            renameSync(
              versionRoot,
              join(
                versionsRoot,
                `.failed-${versionName}-${randomBytes(4).toString("hex")}`,
              ),
            );
          }
          renameSync(stagingRoot, versionRoot);
          // Repair paths only after the atomic rename. Writing staging paths
          // into pyvenv.cfg makes the venv launcher look for a Python binary
          // under the now-nonexistent `.staging-*` directory (exit code 103).
          repairRelocatedRuntime(targetRepo, targetPython);
          const finalError = validateRuntimeTree(
            targetRepo,
            targetPython,
            targetBuildMarker,
            expectedBuildIdentity,
            archivedRuntime || existsSync(sourcePython),
          );
          if (finalError) throw new Error(finalError);
          probeRelocatedRuntime(targetRepo);
        } catch (error) {
          const resolvedStaging = resolve(stagingRoot);
          const resolvedVersions = `${resolve(versionsRoot)}${sep}`;
          if (resolvedStaging.startsWith(resolvedVersions)) {
            rmSync(resolvedStaging, { recursive: true, force: true });
          }
          throw error;
        }
      }
      activateRuntime(
        managedRoot,
        versionName,
        targetRepo,
        expectedBuildIdentity,
      );
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("[installer] Could not prepare the bundled runtime:", detail);
    throw new Error(
      `JingYuAI 运行时升级失败/文件被占用。请关闭旧版 JingYuAI、gateway 和 dashboard 进程后重试。${detail ? ` ${detail}` : ""}`,
    );
  }
}

const BUNDLED_RUNTIME_REPO = resolveBundledRuntimeRepo(
  app?.isPackaged ? process.resourcesPath : "",
  app?.isPackaged ? app.getPath("userData") : "",
  Boolean(app?.isPackaged),
  app?.isPackaged ? app.getVersion() : "",
);
const BUNDLED_RUNTIME_ROOT = BUNDLED_RUNTIME_REPO
  ? dirname(BUNDLED_RUNTIME_REPO)
  : "";
let bundledRuntimePreparation: Promise<void> | null = null;

/**
 * Prepare the packaged Agent/Python runtime exactly once per desktop process.
 * The first caller starts asynchronous filesystem work; concurrent callers
 * await the same promise so no feature can observe a half-copied runtime.
 */
// @lat: [[main-process#Offline Windows runtime]]
export function initializeBundledRuntime(): Promise<void> {
  if (!bundledRuntimePreparation) {
    recordColdStartTiming({ stage: "runtime.prepare_started" });
    const attempt = prepareBundledRuntime().then(async () => {
      await installBundledProfileContent();
      installBundledLookupToken();
      installBundledSoulRules();
      configureBundledPortableGit();
      recordColdStartTiming({ stage: "runtime.ready" });
    });
    const guarded = attempt.catch((error) => {
      recordColdStartTiming({
        stage: "runtime.failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      if (bundledRuntimePreparation === guarded) {
        bundledRuntimePreparation = null;
      }
      throw error;
    });
    bundledRuntimePreparation = guarded;
  }
  return bundledRuntimePreparation;
}

const BUNDLED_PORTABLE_GIT =
  IS_WINDOWS && BUNDLED_RUNTIME_ROOT
    ? {
        root: join(BUNDLED_RUNTIME_ROOT, "git"),
        bash: join(BUNDLED_RUNTIME_ROOT, "git", "bin", "bash.exe"),
        pathEntries: [
          join(BUNDLED_RUNTIME_ROOT, "git", "bin"),
          join(BUNDLED_RUNTIME_ROOT, "git", "cmd"),
          join(BUNDLED_RUNTIME_ROOT, "git", "usr", "bin"),
        ],
      }
    : bundledPortableGitLayout(app?.isPackaged ? process.resourcesPath : "");

function configureBundledPortableGit(): void {
  if (BUNDLED_PORTABLE_GIT && existsSync(BUNDLED_PORTABLE_GIT.bash)) {
    process.env.HERMES_GIT_BASH_PATH = BUNDLED_PORTABLE_GIT.bash;
  }
}
configureBundledPortableGit();

// Resolve the Hermes data directory. Precedence:
//   1. HERMES_HOME env var if set (install.ps1 sets it User-scope on
//      Windows; users may also override manually for WSL/custom setups).
//   2. On Windows, probe both candidates and pick whichever already has
//      data. install.ps1's default is %LOCALAPPDATA%\hermes, but some
//      setups put data at ~/.hermes (e.g. a junction into WSL, or a
//      custom -HermesHome flag on install). Without probing we'd silently
//      switch directories on users who had it working before.
//   3. Fresh install fallback: %LOCALAPPDATA%\hermes on Windows (matches
//      install.ps1's default), ~/.hermes elsewhere.
//
// Motivating bug: Electron launched from the Start Menu doesn't always
// inherit shell-set env vars, so relying on HERMES_HOME alone left
// Windows users staring at an empty ~/.hermes while their real data
// sat in %LOCALAPPDATA%\hermes.
function looksLikeHermesHome(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return (
    existsSync(join(dir, "hermes-agent")) ||
    existsSync(join(dir, "gateway.pid")) ||
    existsSync(join(dir, "config.yaml")) ||
    existsSync(join(dir, "active_profile")) ||
    existsSync(join(dir, ".env"))
  );
}

function defaultHermesHome(): string {
  const homeDot = join(homedir(), ".hermes");
  if (!IS_WINDOWS) return homeDot;

  const localApp = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "hermes")
    : null;

  // Prefer whichever location already has hermes data.
  if (localApp && looksLikeHermesHome(localApp)) return localApp;
  if (looksLikeHermesHome(homeDot)) return homeDot;

  // Neither populated yet — fall back to install.ps1's default so a
  // fresh install lines up with where the installer will write.
  return localApp ?? homeDot;
}

// A Hermes home the user explicitly pointed the app at via the "use an
// existing installation" flow (issue #272). Persisted in the desktop's own
// userData dir — outside any Hermes home — so it can be read here, before
// HERMES_HOME is resolved. Strictly additive: with no override file the
// behaviour is identical to before.
function hermesHomeOverrideFile(): string {
  // `app` is undefined outside an Electron runtime (e.g. unit tests) —
  // optional-chain it so module load degrades to "no override" instead of
  // throwing.
  const userData = app?.getPath?.("userData");
  return userData ? join(userData, "hermes-home.json") : "";
}

function readHermesHomeOverride(): string {
  try {
    const file = hermesHomeOverrideFile();
    if (!file || !existsSync(file)) return "";
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      hermesHome?: unknown;
    };
    const p =
      typeof parsed.hermesHome === "string" ? parsed.hermesHome.trim() : "";
    // Ignore a stale override whose directory no longer exists.
    return p && existsSync(p) ? p : "";
  } catch {
    return "";
  }
}

/** Persist (when `home` is set) or clear (when "") the Hermes home override. */
export function setHermesHomeOverride(home: string): void {
  try {
    const file = hermesHomeOverrideFile();
    if (!file) return;
    if (!home.trim()) {
      if (existsSync(file)) unlinkSync(file);
      return;
    }
    writeFileSync(
      file,
      JSON.stringify({ hermesHome: home.trim() }, null, 2),
      "utf-8",
    );
  } catch {
    /* best effort — a failed write just means no override next launch */
  }
}

export const HERMES_HOME =
  process.env.HERMES_HOME?.trim() ||
  readHermesHomeOverride() ||
  defaultHermesHome();

/** Install builder-selected user Skills and writing templates on first use. */
export async function installBundledProfileContent(
  profile?: string,
): Promise<void> {
  const targetHome = profileHome(profile);
  if (!app.isPackaged) {
    try {
      await installManagedUserSkillsFromDirectory(
        join(app.getAppPath(), "resources", "starter-skills"),
        targetHome,
      );
    } catch {
      // Provisioning performs a fail-closed mandatory Skill check and reports
      // a role-specific error if the development source is unavailable.
    }
    return;
  }
  if (!BUNDLED_RUNTIME_REPO) return;
  try {
    await installPackagedPresetContent(
      join(BUNDLED_RUNTIME_ROOT, "preset-content"),
      targetHome,
    );
  } catch {
    // Presets are optional; startup and existing user content remain usable.
  }
  installBundledAihubKey(targetHome);
}

function installBundledAihubKey(targetHome: string): void {
  const bundledEnv = join(BUNDLED_RUNTIME_ROOT, "aihub-fallback.env");
  const targetEnv = join(targetHome, ".env");
  try {
    if (!existsSync(bundledEnv)) return;
    const existing = existsSync(targetEnv)
      ? readFileSync(targetEnv, "utf-8")
      : "";
    const merged = mergeBundledAihubKey(
      existing,
      readFileSync(bundledEnv, "utf-8"),
    );
    mkdirSync(targetHome, { recursive: true });
    if (merged !== existing) writeFileSync(targetEnv, merged, "utf-8");
  } catch (error) {
    console.warn(
      "[installer] Could not install the bundled AIHub fallback key:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function installBundledLookupToken(): void {
  if (!BUNDLED_RUNTIME_REPO || !app.isPackaged) return;
  const bundledEnv = join(BUNDLED_RUNTIME_ROOT, "employee-lookup.env");
  const targetEnv = join(HERMES_HOME, ".env");
  try {
    if (!existsSync(bundledEnv)) return;
    const existing = existsSync(targetEnv)
      ? readFileSync(targetEnv, "utf-8")
      : "";
    const bundled = readFileSync(bundledEnv, "utf-8");
    const merged = mergeBundledEmployeeLookupToken(existing, bundled);
    mkdirSync(HERMES_HOME, { recursive: true });
    if (merged !== existing) writeFileSync(targetEnv, merged, "utf-8");
  } catch (error) {
    console.warn(
      "[installer] Could not install the bundled employee lookup token:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const COMPANY_VISIBLE_LANGUAGE_RULES_MARKER =
  "<!-- JINGYU_VISIBLE_LANGUAGE_RULES -->";
const STOCK_SOUL_IDENTITY_REPLACEMENTS = [
  [
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
    "You are JingYu Agent, an intelligent AI assistant provided by JingYuAI.",
  ],
  [
    "You are an Agent, an intelligent AI assistant created by Nous Research.",
    "You are JingYu Agent, an intelligent AI assistant provided by JingYuAI.",
  ],
  ["This offline build of Hermes One", "This offline build of JingYu Agent"],
] as const;
const STALE_OFFLINE_TOOLING_GUIDANCE =
  "This offline build of JingYu Agent does not come with Git Bash, curl, or wget pre-installed.\n" +
  "For tasks such as reading web pages, calling HTTP interfaces, and downloading public text content, prioritize using the built-in Python 3 and its standard library urllib.request for implementation. Do not mark a task as unfeasible simply because Git Bash, curl or wget are unavailable.\n" +
  "Only resort to browser tools or other accessible tools when the target webpage requires JavaScript interaction, user login, or the Python request attempt fails.";
const CURRENT_OFFLINE_TOOLING_GUIDANCE =
  "On Windows, this managed offline build includes PortableGit and exposes its Git Bash runtime to agent terminal tools. Optional commands such as curl or wget must still be detected at runtime before use; choose among terminal, Python, and browser tools according to the task.";

/** Replace only exact legacy stock identity text inside a user's SOUL prompt. */
export function migrateStockSoulIdentity(content: string): string {
  const migrated = STOCK_SOUL_IDENTITY_REPLACEMENTS.reduce(
    (updated, [from, to]) => updated.replaceAll(from, to),
    content,
  );
  return migrated.replaceAll(
    STALE_OFFLINE_TOOLING_GUIDANCE,
    CURRENT_OFFLINE_TOOLING_GUIDANCE,
  );
}

/** Append the current company SOUL rule without replacing user-authored text. */
export function mergeBundledSoulRules(
  existing: string,
  bundledRules: string,
): string {
  const migrated = migrateStockSoulIdentity(existing);
  const rules = bundledRules.trim();
  if (!rules || migrated.includes(COMPANY_VISIBLE_LANGUAGE_RULES_MARKER)) {
    return migrated;
  }
  return `${migrated.trimEnd()}${migrated.trimEnd() ? "\n\n" : ""}${rules}\n`;
}

/**
 * Install the package's company-wide visible-language guidance exactly once without
 * replacing the user's own SOUL.md content.  SOUL.md is loaded by Hermes as
 * part of every new agent system prompt, making this more reliable than an
 * optionally-invoked skill for the managed Windows runtime.
 */
function installBundledSoulRules(): void {
  if (!BUNDLED_RUNTIME_REPO || !app.isPackaged) return;
  const bundledRules = join(BUNDLED_RUNTIME_ROOT, "employee-default-soul.md");
  try {
    const rules = existsSync(bundledRules)
      ? readFileSync(bundledRules, "utf-8")
      : "";
    const targetSouls = [join(HERMES_HOME, "SOUL.md")];
    const profilesRoot = join(HERMES_HOME, "profiles");
    if (existsSync(profilesRoot)) {
      for (const entry of readdirSync(profilesRoot, { withFileTypes: true })) {
        const namedSoul = join(profilesRoot, entry.name, "SOUL.md");
        if (entry.isDirectory() && existsSync(namedSoul))
          targetSouls.push(namedSoul);
      }
    }

    for (const targetSoul of targetSouls) {
      const existing = existsSync(targetSoul)
        ? readFileSync(targetSoul, "utf-8")
        : "";
      const next = mergeBundledSoulRules(existing, rules);
      if (next === existing) continue;
      mkdirSync(dirname(targetSoul), { recursive: true });
      writeFileSync(targetSoul, next, "utf-8");
    }
  } catch {
    // The agent still starts with its normal identity if this best-effort
    // company-rule installation cannot write the user's Hermes home.
  }
}

export const HERMES_REPO =
  BUNDLED_RUNTIME_REPO || join(HERMES_HOME, "hermes-agent");
export const HERMES_VENV = join(HERMES_REPO, "venv");
// On Windows, use `pythonw.exe` (the GUI-subsystem interpreter that ships in
// every venv) instead of `python.exe` so that subprocess spawns don't flash
// a blank console window before `windowsHide: true` / CREATE_NO_WINDOW takes
// effect. Issue #342: on every chat send the `sendMessageViaCli` fallback
// path spawned `python.exe`, and the console appeared for a few hundred ms
// despite `windowsHide: true` — a well-known race between console allocation
// and CREATE_NO_WINDOW on console-subsystem child binaries. `pythonw.exe`
// is linked as Windows subsystem, so the OS can never allocate a console
// for it regardless of creation flags. It's a bit-identical interpreter
// otherwise — same modules, same stdout/stderr behaviour over piped stdio
// (which is what every call site here uses).
const WINDOWS_PYTHONW = join(HERMES_VENV, "Scripts", "pythonw.exe");
export function resolveHermesPythonExecutable(
  venv = HERMES_VENV,
  platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string {
  if (platform === "win32") {
    const pythonw = join(venv, "Scripts", "pythonw.exe");
    return pathExists(pythonw)
      ? pythonw
      : join(venv, "Scripts", "python.exe");
  }
  return join(venv, "bin", "python");
}

/** Resolve at process-launch time so first-run Runtime extraction cannot
 * permanently cache the temporary absence of pythonw.exe. */
// @lat: [[main-process#Offline Windows runtime#Dynamic Python launcher]]
export function getHermesPython(): string {
  return resolveHermesPythonExecutable();
}

/** @deprecated Use getHermesPython() for subprocess launches. */
export const HERMES_PYTHON = IS_WINDOWS
  ? WINDOWS_PYTHONW
  : join(HERMES_VENV, "bin", "python");
export const HERMES_SCRIPT = IS_WINDOWS
  ? join(HERMES_VENV, "Scripts", "hermes.exe")
  : join(HERMES_REPO, "hermes");
export const HERMES_ENV_FILE = join(HERMES_HOME, ".env");
export const HERMES_CONFIG_FILE = join(HERMES_HOME, "config.yaml");
export const HERMES_AUTH_FILE = join(HERMES_HOME, "auth.json");

/** The Python + hermes-script paths for a Hermes install rooted at `home`,
 *  in the layout the desktop's own installer produces. */
function installBinariesFor(home: string): { python: string; script: string } {
  const repo = join(home, "hermes-agent");
  const venv = join(repo, "venv");
  return IS_WINDOWS
    ? {
        python: join(venv, "Scripts", "python.exe"),
        script: join(venv, "Scripts", "hermes.exe"),
      }
    : { python: join(venv, "bin", "python"), script: join(repo, "hermes") };
}

export function hermesCliArgs(args: string[] = []): string[] {
  if (process.platform === "win32") {
    return ["-m", "hermes_cli.main", ...args];
  }
  return [HERMES_SCRIPT, ...args];
}

function canInvokeHermesCli(): boolean {
  if (!existsSync(getHermesPython())) return false;
  if (IS_WINDOWS) {
    return existsSync(join(HERMES_REPO, "hermes_cli", "main.py"));
  }
  return existsSync(HERMES_SCRIPT);
}

export interface InstallStatus {
  installed: boolean;
  configured: boolean;
  hasApiKey: boolean;
  verified: boolean;
  managedRuntime: boolean;
  activeProfile?: string;
}

export interface InstallProgress {
  step: number;
  totalSteps: number;
  title: string;
  detail: string;
  log: string;
}

export function getEnhancedPath(): string {
  const home = homedir();
  const extra = (
    IS_WINDOWS
      ? [
          ...(BUNDLED_PORTABLE_GIT?.pathEntries ?? []),
          // Packaged builds use PortableGit above. Legacy installs may still
          // carry the install.ps1 copy under HERMES_HOME.
          join(HERMES_HOME, "git", "bin"),
          join(HERMES_HOME, "git", "cmd"),
          join(HERMES_HOME, "git", "usr", "bin"),
          join(HERMES_HOME, "node"),
          join(HERMES_VENV, "Scripts"),
          // Common user/system installs used when Claw3D setup runs before or
          // outside the bundled installer.
          process.env.NVM_SYMLINK,
          process.env.APPDATA ? join(process.env.APPDATA, "npm") : undefined,
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "nodejs")
            : undefined,
          process.env["ProgramFiles(x86)"]
            ? join(process.env["ProgramFiles(x86)"], "nodejs")
            : undefined,
          process.env.ProgramFiles
            ? join(process.env.ProgramFiles, "Git", "cmd")
            : undefined,
          process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd")
            : undefined,
          // Where `uv` lands when astral.sh's installer runs.
          join(home, ".local", "bin"),
          join(home, ".cargo", "bin"),
        ]
      : [
          join(home, ".local", "bin"),
          join(home, ".cargo", "bin"),
          join(HERMES_VENV, "bin"),
          // Node version manager shim directories
          join(home, ".volta", "bin"),
          join(home, ".asdf", "shims"),
          join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
          join(home, ".fnm", "aliases", "default", "bin"),
          ...resolveNvmBin(home),
          "/usr/local/bin",
          "/opt/homebrew/bin",
          "/opt/homebrew/sbin",
        ]
  ).filter((entry): entry is string => Boolean(entry));
  return [...extra, process.env.PATH || ""].filter(Boolean).join(delimiter);
}

/** Resolve the active nvm node version's bin directory. */
function resolveNvmBin(home: string): string[] {
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  const versionsDir = join(nvmDir, "versions", "node");
  if (!existsSync(versionsDir)) return [];
  try {
    // Try to read the default alias to find the active version
    const aliasFile = join(nvmDir, "alias", "default");
    if (existsSync(aliasFile)) {
      const alias = readFileSync(aliasFile, "utf-8").trim();
      // alias can be a full version "v20.11.0" or a partial "20" or "lts/*"
      if (alias.startsWith("v")) {
        const bin = join(versionsDir, alias, "bin");
        if (existsSync(bin)) return [bin];
      }
    }
    // Fallback: pick the latest installed version
    const versions = (readdirSync(versionsDir) as string[])
      .filter((d: string) => d.startsWith("v"))
      .sort()
      .reverse();
    if (versions.length > 0) {
      return [join(versionsDir, versions[0], "bin")];
    }
  } catch {
    /* non-fatal */
  }
  return [];
}

function activeEnvFile(profile: string): string {
  return profile === "default"
    ? HERMES_ENV_FILE
    : join(HERMES_HOME, "profiles", profile, ".env");
}

function activeAuthFile(profile: string): string {
  return profile === "default"
    ? HERMES_AUTH_FILE
    : join(HERMES_HOME, "profiles", profile, "auth.json");
}

// Canonical env-var name per known model provider. Keys here are values
// the user might see in `model.provider` in config.yaml; values are the
// env vars the gateway expects to read from .env. Names that don't
// appear here either don't need a key (local providers, nous) or have
// OAuth-style credentials (covered separately via hasHermesAuthCredential).
//
// Used by the install-gate check below. Previously that check
// hard-coded only OPENROUTER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY,
// so any user configured for DeepSeek, Groq, Mistral, etc. saw the
// "set AI provider" first-run screen even with a valid key in .env.
// See issue #236.
const PROVIDER_ENV_KEYS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  "ollama-cloud": "OLLAMA_API_KEY",
  aimlapi: "AIMLAPI_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  mistral: "MISTRAL_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
  huggingface: "HF_TOKEN",
  hf: "HF_TOKEN",
  // DashScope: `alibaba` is the canonical agent slug; the rest are the
  // agent's own aliases for it (models.py PROVIDER_ALIASES) — including
  // `qwen`, which every pre-#825 desktop config stored. Only `qwen-oauth`
  // is the Qwen Portal OAuth provider.
  alibaba: "DASHSCOPE_API_KEY",
  dashscope: "DASHSCOPE_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
  aliyun: "DASHSCOPE_API_KEY",
  "alibaba-cloud": "DASHSCOPE_API_KEY",
  "qwen-oauth": "QWEN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  glm: "GLM_API_KEY",
  kimi: "KIMI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  // Nous Portal supports BOTH OAuth (`nous` variant) AND API key
  // (`nous-api` variant). Register the env var name under both ids so
  // the install-gate + pre-send validation + config-health audit can
  // detect a missing key — whichever id the user's profile happens to
  // be configured under. The OAuth case is handled separately by
  // checking auth.json via hasOAuthCredentials() (config.ts).
  nous: "NOUS_API_KEY",
  "nous-api": "NOUS_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
};

// When provider is "custom" or "auto", the desktop's setup flow falls
// back to recognizing the endpoint by base URL. Same patterns hermes.ts
// uses for runtime header injection.
const URL_TO_ENV_KEY: Array<[RegExp, string]> = [
  [/openrouter\.ai/i, "OPENROUTER_API_KEY"],
  [/anthropic\.com/i, "ANTHROPIC_API_KEY"],
  [/openai\.com/i, "OPENAI_API_KEY"],
  [/(^|\/\/|\.)ollama\.com(?=\/|:|$)/i, "OLLAMA_API_KEY"],
  [/api\.aimlapi\.com/i, "AIMLAPI_API_KEY"],
  [/huggingface\.co/i, "HF_TOKEN"],
  [/api\.groq\.com/i, "GROQ_API_KEY"],
  [/api\.deepseek\.com/i, "DEEPSEEK_API_KEY"],
  [/api\.together\.xyz/i, "TOGETHER_API_KEY"],
  [/api\.fireworks\.ai/i, "FIREWORKS_API_KEY"],
  [/api\.cerebras\.ai/i, "CEREBRAS_API_KEY"],
  [/atlascloud\.ai/i, "ATLASCLOUD_API_KEY"],
  [/api\.mistral\.ai/i, "MISTRAL_API_KEY"],
  [/api\.perplexity\.ai/i, "PERPLEXITY_API_KEY"],
  [/api\.xiaomimimo\.com/i, "XIAOMI_API_KEY"],
  [/dashscope(-intl)?\.aliyuncs\.com/i, "DASHSCOPE_API_KEY"],
];

/**
 * Resolve the env var name the gateway expects for a given model config.
 * Returns null when the provider/URL combination has no known canonical
 * env var (the caller falls back to a permissive `*_API_KEY|*_TOKEN`
 * scan, matching the spirit of the prior hard-coded check).
 *
 * Exported for unit testing.
 */
export function expectedEnvKeyForModel(
  provider: string,
  baseUrl: string,
): string | null {
  const direct = PROVIDER_ENV_KEYS[provider.trim().toLowerCase()];
  if (direct) return direct;
  for (const [pattern, envKey] of URL_TO_ENV_KEY) {
    if (pattern.test(baseUrl)) return envKey;
  }
  return null;
}

function envHasUsableValue(
  content: string,
  expectedKey: string | null,
): boolean {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // Strip surrounding quotes so `KEY=""` or `KEY="abc"` parse the
    // same way as `KEY=abc`.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value) continue;

    if (expectedKey) {
      if (key === expectedKey) return true;
    } else {
      // No known mapping for this provider/URL — accept any value that
      // looks like a credential. Avoids regressing users on providers
      // we haven't catalogued explicitly, while still rejecting
      // unrelated env vars (TELEGRAM_BOT_TOKEN etc. shouldn't satisfy
      // the model install gate, but a custom `*_API_KEY` should).
      if (/_API_KEY$/.test(key)) return true;
    }
  }
  return false;
}

// ── Pre-install inspection (issue #272) ──────────────────────────────────────

export type InstallTargetState = "fresh" | "update" | "replace";

export interface InstallTargetInfo {
  /** Where the desktop will install — shown to the user before they commit. */
  hermesHome: string;
  repoPath: string;
  /** What the installer will do to `repoPath`:
   *  - `fresh`   — nothing is there; a clean install.
   *  - `update`  — a valid git checkout; install.sh/ps1 updates it in place.
   *  - `replace` — a directory is there but not a valid checkout, so the
   *                install script deletes and re-clones it. */
  state: InstallTargetState;
}

/** Classify what the installer will do to the target directory. Pure — the
 *  filesystem probing lives in `inspectInstallTarget`. */
export function classifyInstallTarget(
  repoExists: boolean,
  repoIsGitRepo: boolean,
): InstallTargetState {
  if (!repoExists) return "fresh";
  return repoIsGitRepo ? "update" : "replace";
}

/** Inspect the install target so the renderer can warn before installing. */
export function inspectInstallTarget(): InstallTargetInfo {
  const repoExists = existsSync(HERMES_REPO);
  const repoIsGitRepo = repoExists && existsSync(join(HERMES_REPO, ".git"));
  return {
    hermesHome: HERMES_HOME,
    repoPath: HERMES_REPO,
    state: classifyInstallTarget(repoExists, repoIsGitRepo),
  };
}

/** True when `dir` is a Hermes home the desktop can drive as-is — it must
 *  contain a `hermes-agent` install with the venv binaries in the layout the
 *  desktop expects. A hand-rolled install with a different layout fails here
 *  rather than being silently adopted into a broken state (issue #272). */
export function validateHermesHome(dir: string): boolean {
  const home = dir?.trim();
  if (!home || !existsSync(home)) return false;
  const { python, script } = installBinariesFor(home);
  return existsSync(python) && existsSync(script);
}

export function checkInstallStatus(): InstallStatus {
  const activeProfile = getActiveProfileNameSync();

  // Remote mode: skip local checks entirely
  const conn = getConnectionConfig();
  if (conn.mode === "remote" && conn.remoteUrl) {
    return {
      installed: true,
      configured: true,
      hasApiKey: true,
      verified: true,
      managedRuntime: Boolean(BUNDLED_RUNTIME_REPO && app?.isPackaged),
      activeProfile,
    };
  }

  // Fast path: file existence is enough to gate the UI. The deep
  // `python --version` check used to run here adds 1–10s of cold-start
  // latency, so it now lives in `verifyInstall()` and is invoked lazily
  // by the renderer after the main UI is mounted.
  const installed = existsSync(getHermesPython()) && existsSync(HERMES_SCRIPT);
  const envFile = activeEnvFile(activeProfile);
  const authFile = activeAuthFile(activeProfile);
  const configured = existsSync(envFile) || existsSync(authFile);
  let hasApiKey = false;
  const verified = installed;

  // Local/custom providers don't need an API key. OAuth-backed providers
  // (including credential-pool entries) can be configured through Hermes
  // auth.json instead of .env, so check those before falling back to keys.
  let mc: { provider: string; model: string; baseUrl: string } | null = null;
  try {
    mc = getModelConfig(activeProfile);
    if (
      providerDoesNotNeedApiKey(mc.provider) ||
      hasOAuthCredentials(mc.provider, activeProfile)
    ) {
      hasApiKey = true;
    }
  } catch {
    /* ignore */
  }

  if (!hasApiKey && configured && existsSync(envFile)) {
    try {
      const content = readFileSync(envFile, "utf-8");
      const expectedKey = mc
        ? expectedEnvKeyForModel(mc.provider, mc.baseUrl)
        : null;
      hasApiKey = envHasUsableValue(content, expectedKey);
    } catch {
      /* ignore read errors */
    }
  }

  return {
    installed,
    configured,
    hasApiKey,
    verified,
    managedRuntime: Boolean(BUNDLED_RUNTIME_REPO && app?.isPackaged),
    activeProfile,
  };
}

// Lazy background verification: actually invoke Python to confirm the
// install runs. Called from the renderer after the UI is already up.
let _verifyCache: { ok: boolean; ts: number } | null = null;
const VERIFY_TTL_MS = 5 * 60 * 1000;

export async function verifyInstall(): Promise<boolean> {
  if (!canInvokeHermesCli()) return false;
  if (_verifyCache && Date.now() - _verifyCache.ts < VERIFY_TTL_MS) {
    return _verifyCache.ok;
  }
  return new Promise((resolve) => {
    execFile(
      getHermesPython(),
      hermesCliArgs(["--version"]),
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
        },
        timeout: 15000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error) => {
        const ok = !error;
        _verifyCache = { ok, ts: Date.now() };
        resolve(ok);
      },
    );
  });
}

// Cached version to avoid re-running the Python process
let _cachedVersion: string | null = null;
let _versionFetching = false;

export async function getHermesVersion(): Promise<string | null> {
  if (_cachedVersion !== null) return _cachedVersion;
  if (!canInvokeHermesCli()) return null;
  if (_versionFetching) {
    // Wait for the in-flight fetch but cap the wait. The execFile below
    // has a 15s timeout and its callback unconditionally clears
    // `_versionFetching`, so under normal failure paths the poll
    // unblocks on its own. Pathological cases (callback never invoked,
    // worker killed mid-callback, async exception in handler) would
    // otherwise leak a 100 ms interval per caller forever. Cap at 20s
    // — comfortably above the execFile timeout — and resolve with
    // whatever `_cachedVersion` happens to be (typically `null`),
    // which matches the same return shape callers already handle.
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = setInterval(() => {
        if (!_versionFetching || Date.now() - startedAt > 20_000) {
          clearInterval(check);
          resolve(_cachedVersion);
        }
      }, 100);
    });
  }
  _versionFetching = true;
  return new Promise((resolve) => {
    execFile(
      getHermesPython(),
      hermesCliArgs(["--version"]),
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
        },
        timeout: 15000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout) => {
        _versionFetching = false;
        if (error) {
          resolve(null);
        } else {
          _cachedVersion = stdout.toString().trim();
          resolve(_cachedVersion);
        }
      },
    );
  });
}

export function clearVersionCache(): void {
  _cachedVersion = null;
}

export function runHermesDoctor(): string {
  if (!canInvokeHermesCli()) {
    return "JingYuAI is not installed.";
  }
  try {
    const output = execFileSync(getHermesPython(), hermesCliArgs(["doctor"]), {
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
    });
    return stripAnsi(output.toString());
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() || "";
    return stripAnsi(stderr) || "Doctor check failed.";
  }
}

const OPENCLAW_DIR_NAMES = [".openclaw", ".clawdbot", ".moldbot"];

// hermes-desktop itself creates ~/.openclaw/claw3d/ as a stub when preparing
// Claw3D settings (see claw3d.ts:writeClaw3dSettings), so a bare `existsSync`
// check would surface that empty stub as a "real" OpenClaw install and
// prompt the user to migrate from themselves. Require at least one regular
// file anywhere in the tree so empty scaffolding doesn't trigger the banner.
function dirContainsAnyFile(dir: string, maxDepth = 3): boolean {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && maxDepth > 0) {
        if (dirContainsAnyFile(join(dir, entry.name), maxDepth - 1)) {
          return true;
        }
      }
    }
  } catch {
    // unreadable → treat as empty
  }
  return false;
}

export function checkOpenClawExists(home: string = homedir()): {
  found: boolean;
  path: string | null;
} {
  for (const name of OPENCLAW_DIR_NAMES) {
    const dir = join(home, name);
    if (existsSync(dir) && dirContainsAnyFile(dir)) {
      return { found: true, path: dir };
    }
  }
  return { found: false, path: null };
}

export async function runClawMigrate(
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  if (!existsSync(getHermesPython()) || !existsSync(HERMES_SCRIPT)) {
    throw new Error("JingYuAI is not installed.");
  }

  const openclaw = checkOpenClawExists();
  if (!openclaw.found) {
    throw new Error("No OpenClaw installation found.");
  }

  let log = "";
  function emit(text: string): void {
    log += text;
    onProgress({
      step: 1,
      totalSteps: 1,
      title: "Migrating from OpenClaw",
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  emit(`Migrating from ${openclaw.path}...\n`);

  return new Promise((resolve, reject) => {
    const args = hermesCliArgs(["claw", "migrate", "--preset", "full"]);

    const proc = spawn(getHermesPython(), args, {
      cwd: HERMES_REPO,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        HOME: homedir(),
        HERMES_HOME,
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit("\nMigration complete!\n");
        resolve();
      } else {
        reject(new Error(`Migration failed (exit code ${code}).`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run migration: ${err.message}`));
    });
  });
}

export async function runHermesUpdate(
  onProgress: (progress: InstallProgress) => void,
): Promise<void> {
  if (!existsSync(getHermesPython()) || !existsSync(HERMES_SCRIPT)) {
    throw new Error("JingYuAI is not installed. Please install it first.");
  }

  let log = "";
  function emit(text: string): void {
    log += text;
    onProgress({
      step: 1,
      totalSteps: 1,
      title: "Updating JingYuAI Agent",
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  emit("Running hermes update...\n");

  return new Promise((resolve, reject) => {
    const proc = spawn(getHermesPython(), hermesCliArgs(["update"]), {
      cwd: HERMES_REPO,
      env: {
        ...process.env,
        PATH: getEnhancedPath(),
        HOME: homedir(),
        HERMES_HOME,
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        emit("\nUpdate complete!\n");
        resolve();
      } else {
        reject(new Error(`Update failed (exit code ${code}).`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run update: ${err.message}`));
    });
  });
}

function getShellProfile(home: string): string | null {
  // Check for the user's shell profile to source their PATH
  const candidates = [
    join(home, ".zshrc"),
    join(home, ".bashrc"),
    join(home, ".bash_profile"),
    join(home, ".profile"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Parse install.sh / install.ps1 output to detect progress stages.
// Patterns are tuned to match both bash and PowerShell installer phrasing.
const STAGE_MARKERS: { pattern: RegExp; step: number; title: string }[] = [
  {
    pattern: /Checking (for )?(git|uv|python|node|ripgrep|ffmpeg)/i,
    step: 1,
    title: "Checking prerequisites",
  },
  {
    pattern: /Installing uv|uv found|uv installed/i,
    step: 2,
    title: "Setting up package manager",
  },
  {
    pattern: /Installing Python|Python .* found|Python installed/i,
    step: 3,
    title: "Setting up Python",
  },
  {
    pattern:
      /Cloning|cloning|Updating.*repository|Repository|Installing to .*hermes-agent|Downloading PortableGit/i,
    step: 4,
    title: "Downloading JingYuAI Agent",
  },
  {
    pattern: /Creating virtual|virtual environment|uv venv|\bvenv\b/i,
    step: 5,
    title: "Creating Python environment",
  },
  {
    pattern:
      /pip install|Installing.*packages|dependencies|Trying tier|Resolving|Main package installed/i,
    step: 6,
    title: "Installing dependencies",
  },
  {
    // Only fire step 7 on the install script's actual final lines.
    // Intermediate "Browser engine setup complete" / "All dependencies installed"
    // used to match here and pinned the progress bar at 100% while Playwright
    // and TUI deps were still running — see issue #104.
    pattern:
      /Installation complete|hermes command ready|Configuration directory ready|Hermes (installation )?(finished|is ready)/i,
    step: 7,
    title: "Finishing setup",
  },
];

export async function runInstall(
  onProgress: (progress: InstallProgress) => void,
  parentWindow?: BrowserWindow | null,
): Promise<void> {
  if (app?.isPackaged && BUNDLED_RUNTIME_REPO) {
    throw new Error(
      "受管理的 JingYuAI 运行时不能使用通用安装器覆盖；请重试运行时修复。",
    );
  }
  const totalSteps = 7;
  let log = "";
  let currentStep = 1;
  let currentTitle = "Starting installation...";

  function emit(text: string): void {
    log += text;
    // Try to detect which stage we're in from the output
    for (const marker of STAGE_MARKERS) {
      if (marker.pattern.test(text)) {
        if (marker.step >= currentStep) {
          currentStep = marker.step;
          currentTitle = marker.title;
        }
        break;
      }
    }
    onProgress({
      step: currentStep,
      totalSteps,
      title: currentTitle,
      detail: text.trim().slice(0, 120),
      log,
    });
  }

  emit("Running the JingYuAI install script...\n");

  if (IS_WINDOWS) {
    return runInstallWindows(emit);
  }

  // Ask for the sudo password ONCE upfront and warm sudo's credential cache
  // before install.sh runs. Playwright's `install --with-deps` later invokes
  // `sudo apt-get` from a subprocess with no TTY — without a warm cache it
  // hangs forever waiting on stdin. See issues #104 and #109.
  emit("→ Checking administrator access...\n");
  const sudoPrecache = await precacheSudoCredentials(parentWindow ?? null);
  if (sudoPrecache.cancelled) {
    throw new Error(
      "Installation cancelled: administrator password is required to install browser libraries.",
    );
  }
  if (!sudoPrecache.ok) {
    emit(
      "⚠ Administrator password was not accepted. Continuing without — install may stall at the browser dependency step.\n",
    );
  } else {
    emit("✓ Administrator access granted\n");
  }

  // Keep the legacy askpass bridge as a fallback for any sudo call that
  // somehow escapes the cred cache (e.g. install runs past sudo's 15min TTL
  // and the keepalive failed).
  let askpass: AskpassHandle | null = null;
  try {
    askpass = await setupAskpass(parentWindow ?? null);
  } catch (err) {
    emit(
      `\n[askpass] Could not set up GUI password bridge: ${(err as Error).message}\n`,
    );
  }

  try {
    return await new Promise<void>((resolve, reject) => {
      const home = homedir();

      // Source the user's shell profile to get the same PATH as their terminal,
      // then run the official install script. Electron apps launched from Finder
      // don't inherit the terminal environment.
      const shellProfile = getShellProfile(home);
      const installCmd = [
        shellProfile ? `source "${shellProfile}" 2>/dev/null;` : "",
        "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
      ].join(" ");

      const basePath = getEnhancedPath();
      const proc = spawn("bash", ["-c", installCmd], {
        cwd: home,
        env: {
          ...process.env,
          PATH: askpass ? `${askpass.pathPrepend}:${basePath}` : basePath,
          HOME: home,
          TERM: "dumb",
          ...(askpass?.env ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...HIDDEN_SUBPROCESS_OPTIONS,
      });

      proc.stdout?.on("data", (data: Buffer) => {
        emit(stripAnsi(data.toString()));
      });

      proc.stderr?.on("data", (data: Buffer) => {
        emit(stripAnsi(data.toString()));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          emit("\nInstallation complete!\n");
          resolve();
        } else {
          // The install script can exit non-zero due to benign issues
          // (e.g. git stash pop failure on already-clean repo).
          // If Hermes is actually installed and working, treat as success.
          if (existsSync(getHermesPython()) && existsSync(HERMES_SCRIPT)) {
            emit(
              "\nInstall script exited with warnings, but JingYuAI is installed successfully.\n",
            );
            resolve();
          } else {
            reject(
              new Error(
                `Installation failed (exit code ${code}). You can try installing via terminal instead.`,
              ),
            );
          }
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to start installer: ${err.message}`));
      });
    });
  } finally {
    askpass?.cleanup();
    sudoPrecache.stop();
  }
}

// PS single-quoted string escape: ' → ''
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Resolve a powershell executable. Prefer PowerShell 7 (`pwsh`) when present,
// fall back to Windows PowerShell 5.1 (`powershell.exe`). Both ship the same
// flags we use; pwsh is faster and writes UTF-8 without a BOM by default.
function resolvePowerShellExe(): string {
  // Spawn will resolve from PATH; we test for pwsh.exe first.
  const programFiles = process.env["ProgramFiles"];
  const candidates = [
    programFiles ? join(programFiles, "PowerShell", "7", "pwsh.exe") : null,
    "pwsh.exe",
    "powershell.exe",
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    if (c.includes("\\") && existsSync(c)) return c;
  }
  // Let spawn search PATH for the bare names; powershell.exe ships on every
  // supported Windows version, so this is always resolvable.
  return "powershell.exe";
}

async function runInstallWindows(emit: (t: string) => void): Promise<void> {
  // We can't `irm | iex` and pass parameters, and we want to override the
  // upstream defaults (which install to %LOCALAPPDATA%\hermes) so the
  // desktop app's HERMES_HOME == ~\.hermes convention keeps working.
  // Strategy: write a small wrapper .ps1 to %TEMP%, run it with -File.
  const home = homedir();
  const hermesHome = HERMES_HOME;
  const installDir = HERMES_REPO;

  const wrapperPath = join(
    tmpdir(),
    `hermes-install-${randomBytes(6).toString("hex")}.ps1`,
  );

  // The wrapper downloads install.ps1 to a sibling temp file and invokes it
  // with our parameters. This sidesteps the `iex`-can't-pass-args limitation.
  const wrapperScript = [
    "$ErrorActionPreference = 'Stop'",
    `$hermesHome = ${psQuote(hermesHome)}`,
    `$installDir = ${psQuote(installDir)}`,
    // Force TLS 1.2 for older Windows PowerShell 5.1 hosts that still default
    // to TLS 1.0 — github raw refuses TLS < 1.2.
    "try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}",
    "$url = 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1'",
    `$installer = Join-Path $env:TEMP ("hermes-install-script-" + [guid]::NewGuid().ToString() + ".ps1")`,
    // Windows PowerShell 5.1 parses BOM-less files as the legacy ANSI codepage,
    // which mangles the non-ASCII glyphs in install.ps1 and produces parse
    // errors (see issue #149). Re-save with a UTF-8 BOM so PS 5.1 reads it as
    // UTF-8. Idempotent if upstream later adds its own BOM or switches to ASCII.
    "$resp = Invoke-WebRequest -Uri $url -UseBasicParsing",
    "$text = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }",
    "if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }",
    "[System.IO.File]::WriteAllText($installer, $text, (New-Object System.Text.UTF8Encoding $true))",
    "$exit = 1",
    "try {",
    "  & $installer -SkipSetup -NonInteractive -HermesHome $hermesHome -InstallDir $installDir",
    "  $exit = $LASTEXITCODE",
    "} finally {",
    "  if ($env:HERMES_DESKTOP_SANDBOX -eq '1') {",
    "    $sandboxVenv = Join-Path $installDir 'venv\\Scripts'",
    "    $userHermesHome = [Environment]::GetEnvironmentVariable('HERMES_HOME', 'User')",
    "    if ($userHermesHome -and ($userHermesHome.TrimEnd('\\') -ieq $hermesHome.TrimEnd('\\'))) {",
    "      [Environment]::SetEnvironmentVariable('HERMES_HOME', $null, 'User')",
    "    }",
    "    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "    if ($userPath) {",
    "      $parts = $userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $sandboxVenv.TrimEnd('\\')) }",
    "      [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')",
    "    }",
    "  }",
    "}",
    "Remove-Item -Force -ErrorAction SilentlyContinue $installer",
    "exit $exit",
    "",
  ].join("\r\n");

  try {
    writeFileSync(wrapperPath, wrapperScript, { encoding: "utf8" });
  } catch (err) {
    throw new Error(
      `Failed to stage Windows installer: ${(err as Error).message}`,
    );
  }

  const psExe = resolvePowerShellExe();
  const basePath = getEnhancedPath();

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      psExe,
      [
        "-ExecutionPolicy",
        "Bypass",
        "-NoProfile",
        "-NonInteractive",
        "-File",
        wrapperPath,
      ],
      {
        cwd: home,
        env: {
          ...process.env,
          PATH: basePath,
          HERMES_HOME: hermesHome,
          // Hint that we're not interactive so install.ps1 doesn't `pause`
          // (the .cmd wrapper does on failure, but -File on .ps1 won't).
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
    );

    proc.stdout?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.stderr?.on("data", (data: Buffer) => {
      emit(stripAnsi(data.toString()));
    });

    proc.on("close", (code) => {
      try {
        unlinkSync(wrapperPath);
      } catch {
        /* best-effort */
      }
      if (code === 0) {
        emit("\nInstallation complete!\n");
        resolve();
        return;
      }
      // Same tolerance as the bash path: if the binary tree exists, count it.
      if (existsSync(getHermesPython()) && existsSync(HERMES_SCRIPT)) {
        emit(
          "\nInstall script exited with warnings, but JingYuAI is installed successfully.\n",
        );
        resolve();
      } else {
        reject(
          new Error(
            `Installation failed (exit code ${code}). Open PowerShell and try: irm https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1 | iex`,
          ),
        );
      }
    });

    proc.on("error", (err) => {
      try {
        unlinkSync(wrapperPath);
      } catch {
        /* best-effort */
      }
      // Most common failure: PowerShell is missing or blocked by policy.
      const hint =
        (err as NodeJS.ErrnoException).code === "ENOENT"
          ? " PowerShell was not found. Reinstall Windows PowerShell or run the installer manually from a terminal."
          : "";
      reject(new Error(`Failed to start installer: ${err.message}.${hint}`));
    });
  });
}

// ────────────────────────────────────────────────────
//  Backup & Import
// ────────────────────────────────────────────────────

export async function runHermesBackup(
  profile?: string,
): Promise<{ success: boolean; path?: string; error?: string }> {
  if (!existsSync(getHermesPython()) || !existsSync(HERMES_SCRIPT)) {
    return { success: false, error: "JingYuAI is not installed." };
  }
  const args = hermesCliArgs();
  if (profile && profile !== "default") args.push("-p", profile);
  args.push("backup");

  return new Promise((resolve) => {
    execFile(
      getHermesPython(),
      args,
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
          TERM: "dumb",
        },
        timeout: 120000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: stripAnsi(stderr || error.message).slice(0, 500),
          });
          return;
        }
        const output = stripAnsi(stdout);
        // Try to extract the backup file path from output
        const pathMatch = output.match(
          /(?:Backup saved|Written|Created).*?(\S+\.(?:tar\.gz|zip|tgz))/i,
        );
        resolve({
          success: true,
          path: pathMatch?.[1] || output.trim().split("\n").pop()?.trim(),
        });
      },
    );
  });
}

export async function runHermesImport(
  archivePath: string,
  profile?: string,
): Promise<{ success: boolean; error?: string }> {
  const archive = validateImportArchivePath(archivePath);
  if (!archive.success) {
    return { success: false, error: archive.error };
  }

  if (!existsSync(getHermesPython()) || !existsSync(HERMES_SCRIPT)) {
    return { success: false, error: "JingYuAI is not installed." };
  }
  const args = hermesCliArgs();
  if (profile && profile !== "default") args.push("-p", profile);
  args.push("import", archive.path);

  return new Promise((resolve) => {
    execFile(
      getHermesPython(),
      args,
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
          TERM: "dumb",
        },
        timeout: 120000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, _stdout, stderr) => {
        if (error) {
          resolve({
            success: false,
            error: stripAnsi(stderr || error.message).slice(0, 500),
          });
          return;
        }
        resolve({ success: true });
      },
    );
  });
}

export function validateImportArchivePath(
  archivePath: unknown,
): { success: true; path: string } | { success: false; error: string } {
  if (typeof archivePath !== "string" || archivePath.trim() === "") {
    return { success: false, error: "Import archive path is required." };
  }

  const path = resolve(archivePath);
  if (!existsSync(path)) {
    return { success: false, error: "Import archive does not exist." };
  }

  try {
    if (!statSync(path).isFile()) {
      return { success: false, error: "Import archive must be a file." };
    }
  } catch {
    return { success: false, error: "Import archive is not readable." };
  }

  return { success: true, path };
}

// ────────────────────────────────────────────────────
//  Debug dump
// ────────────────────────────────────────────────────

export function runHermesDump(): Promise<string> {
  if (!existsSync(getHermesPython()) || !existsSync(HERMES_SCRIPT)) {
    return Promise.resolve("JingYuAI is not installed.");
  }
  return new Promise((resolve) => {
    execFile(
      getHermesPython(),
      hermesCliArgs(["dump"]),
      {
        cwd: HERMES_REPO,
        env: {
          ...process.env,
          PATH: getEnhancedPath(),
          HOME: homedir(),
          HERMES_HOME,
          TERM: "dumb",
        },
        timeout: 30000,
        ...HIDDEN_SUBPROCESS_OPTIONS,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve(stripAnsi(stderr || error.message));
        } else {
          resolve(stripAnsi(stdout));
        }
      },
    );
  });
}

// ────────────────────────────────────────────────────
//  Memory provider discovery
// ────────────────────────────────────────────────────

export interface MemoryProviderInfo {
  name: string;
  description: string;
  installed: boolean;
  active: boolean;
  envVars: string[];
}

/**
 * Discover available memory providers by scanning the plugins directory
 * and reading config.yaml for the active provider.
 */
export function discoverMemoryProviders(
  profile?: string,
): MemoryProviderInfo[] {
  const pluginsDir = join(HERMES_REPO, "plugins", "memory");
  if (!existsSync(pluginsDir)) return [];

  const activeProvider = getActiveMemoryProvider(profile);

  // Known providers with their metadata (from plugin.yaml files)
  const KNOWN_PROVIDERS: Record<
    string,
    { description: string; envVars: string[]; pip?: string }
  > = {
    honcho: {
      description: "memory.providers.honcho",
      envVars: ["HONCHO_API_KEY"],
      pip: "honcho-ai",
    },
    hindsight: {
      description: "memory.providers.hindsight",
      envVars: ["HINDSIGHT_API_KEY", "HINDSIGHT_API_URL", "HINDSIGHT_BANK_ID"],
      pip: "hindsight-client",
    },
    mem0: {
      description: "memory.providers.mem0",
      envVars: ["MEM0_API_KEY"],
      pip: "mem0ai",
    },
    retaindb: {
      description: "memory.providers.retaindb",
      envVars: ["RETAINDB_API_KEY"],
    },
    supermemory: {
      description: "memory.providers.supermemory",
      envVars: ["SUPERMEMORY_API_KEY"],
      pip: "supermemory",
    },
    holographic: {
      description: "memory.providers.holographic",
      envVars: [],
    },
    openviking: {
      description: "memory.providers.openviking",
      envVars: ["OPENVIKING_ENDPOINT", "OPENVIKING_API_KEY"],
    },
    byterover: {
      description: "memory.providers.byterover",
      envVars: ["BRV_API_KEY"],
    },
  };

  const results: MemoryProviderInfo[] = [];

  try {
    const dirs = readdirSync(pluginsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith("_")) continue;
      const name = d.name;
      const known = KNOWN_PROVIDERS[name];
      const initFile = join(pluginsDir, name, "__init__.py");
      const installed = existsSync(initFile);

      results.push({
        name,
        description: known?.description || name,
        installed,
        active: name === activeProvider,
        envVars: known?.envVars || [],
      });
    }
  } catch {
    /* non-fatal */
  }

  // Sort: active first, then installed, then alphabetical
  results.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * Read the active memory provider from config.yaml.
 */
export function getActiveMemoryProvider(profile?: string): string {
  try {
    const configPath = join(profileHome(profile), "config.yaml");
    if (!existsSync(configPath)) return "";
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(/^\s*provider:\s*["']?(\w+)["']?\s*$/m);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────
//  MCP server management
// ────────────────────────────────────────────────────

export function listMcpServers(
  profile?: string,
): Array<{ name: string; type: string; enabled: boolean; detail: string }> {
  try {
    const configPath = join(profileHome(profile), "config.yaml");
    if (!existsSync(configPath)) return [];
    const content = readFileSync(configPath, "utf-8");
    // Simple YAML parse for mcp_servers section
    const match = content.match(/^mcp_servers:\s*\n((?:[ \t]+.+\n)*)/m);
    if (!match) return [];

    const servers: Array<{
      name: string;
      type: string;
      enabled: boolean;
      detail: string;
    }> = [];
    const block = match[1];
    // Each top-level key under mcp_servers is a server name (2-space indent)
    const nameRe = /^[ ]{2}(\w[\w-]*):\s*$/gm;
    let m: RegExpExecArray | null;
    while ((m = nameRe.exec(block)) !== null) {
      const name = m[1];
      // Extract following indented block for this server.
      // Find the next line at exactly 2-space indent (next server name).
      const start = m.index + m[0].length;
      const nextMatch = /\n {2}\w/g;
      nextMatch.lastIndex = start;
      const next = nextMatch.exec(block);
      const serverBlock = block.slice(start, next ? next.index : undefined);
      const hasUrl = /url:/.test(serverBlock);
      const hasCommand = /command:/.test(serverBlock);
      const enabledMatch = serverBlock.match(/enabled:\s*(true|false)/i);
      const enabled =
        enabledMatch === null || enabledMatch[1].toLowerCase() === "true";

      let detail = "";
      if (hasUrl) {
        const urlMatch = serverBlock.match(/url:\s*["']?([^\s"']+)/);
        detail = urlMatch?.[1] || "HTTP";
      } else if (hasCommand) {
        const cmdMatch = serverBlock.match(/command:\s*["']?([^\s"']+)/);
        detail = cmdMatch?.[1] || "stdio";
      }

      servers.push({
        name,
        type: hasUrl ? "http" : "stdio",
        enabled,
        detail,
      });
    }
    return servers;
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────
//  Log viewer
// ────────────────────────────────────────────────────

export function readLogs(
  logFile = "agent.log",
  lines = 200,
): { content: string; path: string } {
  const logsDir = join(HERMES_HOME, "logs");
  // Sanitize: only allow known log file names
  const allowed = ["agent.log", "errors.log", "gateway.log"];
  const file = allowed.includes(logFile) ? logFile : "agent.log";
  const fullPath = join(logsDir, file);

  if (!existsSync(fullPath)) {
    return { content: "", path: fullPath };
  }
  try {
    const content = readFileSync(fullPath, "utf-8");
    // Return the last N lines
    const allLines = content.split("\n");
    const tail = allLines.slice(-lines).join("\n");
    return { content: tail, path: fullPath };
  } catch {
    return { content: "", path: fullPath };
  }
}
