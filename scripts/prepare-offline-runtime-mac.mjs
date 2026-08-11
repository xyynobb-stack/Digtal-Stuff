import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchCronOutputDirectories } from "./patch-cron-output-directories.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const windowsRuntimeSource = path.join(
  projectRoot,
  "build",
  "offline-runtime",
  "hermes-agent",
);
const sourceRepo = path.resolve(
  process.env.HERMES_AGENT_SOURCE || windowsRuntimeSource,
);
const presetContentSource = path.join(
  projectRoot,
  "build",
  "offline-runtime",
  "preset-content",
);
const outputRoot = path.join(projectRoot, "build", "offline-runtime-mac");
const standaloneTag = process.env.PYTHON_BUILD_STANDALONE_TAG || "20260718";
const targetArch = process.env.MAC_TARGET_ARCH || process.arch;
const targetTriple =
  targetArch === "arm64"
    ? "aarch64-apple-darwin"
    : targetArch === "x64"
      ? "x86_64-apple-darwin"
      : "";

if (process.platform !== "darwin") {
  throw new Error(
    "prepare:offline-runtime-mac must run on a macOS runner. Use GitHub Actions from Windows.",
  );
}
if (!targetTriple) {
  throw new Error(`Unsupported macOS architecture: ${targetArch}`);
}
if (process.arch !== targetArch) {
  throw new Error(
    `The ${targetArch} runtime must be built on a ${targetArch} macOS runner; current runner is ${process.arch}.`,
  );
}
if (!fs.existsSync(sourceRepo)) {
  throw new Error(`Hermes Agent source not found: ${sourceRepo}`);
}

function validPresetDirectories(root, requiredFile) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(root, entry.name, requiredFile)),
    )
    .map((entry) => entry.name);
}

// GitHub's macOS runners cannot read the Windows builder's local Hermes home.
// The Windows offline preparation command snapshots the selected local user
// content here; that snapshot must be committed before dispatching this job.
const presetSkillsSource = path.join(
  presetContentSource,
  "skills",
  "custom",
);
const presetTemplatesSource = path.join(
  presetContentSource,
  "writing-templates",
);
const presetSkills = validPresetDirectories(presetSkillsSource, "SKILL.md");
const presetTemplates = validPresetDirectories(
  presetTemplatesSource,
  "metadata.json",
);
if (presetSkills.length === 0 || presetTemplates.length === 0) {
  throw new Error(
    "Committed preset content is missing. On the Windows builder, run " +
      "`npm.cmd run prepare:offline-runtime`, commit " +
      "`build/offline-runtime/preset-content`, then dispatch the macOS workflow.",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
  }
}

function copyAgentSource(source, destination) {
  const excluded = new Set([
    ".git",
    "node_modules",
    "tests",
    "tests-js",
    "docs",
    "website",
    "assets",
    "contributors",
    "__pycache__",
    "venv",
  ]);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return !excluded.has(name) && !name.startsWith("venv.");
    },
  });
}

async function downloadStandalonePython(archivePath) {
  const endpoint = `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${standaloneTag}`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "jingyuai-desktop-macos-builder",
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  };
  const releaseResponse = await fetch(endpoint, { headers });
  if (!releaseResponse.ok) {
    throw new Error(
      `Could not read Python standalone release ${standaloneTag}: HTTP ${releaseResponse.status}`,
    );
  }
  const release = await releaseResponse.json();
  const preferredSuffix = `-${targetTriple}-install_only_stripped.tar.gz`;
  const fallbackSuffix = `-${targetTriple}-install_only.tar.gz`;
  const asset =
    release.assets?.find(
      (entry) =>
        typeof entry.name === "string" &&
        entry.name.startsWith("cpython-3.13.") &&
        entry.name.endsWith(preferredSuffix),
    ) ||
    release.assets?.find(
      (entry) =>
        typeof entry.name === "string" &&
        entry.name.startsWith("cpython-3.13.") &&
        entry.name.endsWith(fallbackSuffix),
    );
  if (!asset?.browser_download_url) {
    throw new Error(
      `No CPython 3.13 ${targetTriple} install_only archive found in release ${standaloneTag}.`,
    );
  }
  console.log(`Downloading ${asset.name}`);
  const archiveResponse = await fetch(asset.browser_download_url, { headers });
  if (!archiveResponse.ok) {
    throw new Error(`Could not download ${asset.name}: HTTP ${archiveResponse.status}`);
  }
  fs.writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
}

function findPythonRoot(root) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.shift();
    if (fs.existsSync(path.join(current, "bin", "python3"))) return current;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  throw new Error("The downloaded Python archive did not contain bin/python3.");
}

/**
 * The stripped CPython macOS archives can retain convenience symlinks such as
 * `bin/pydoc3` while omitting the target command. Electron Builder walks every
 * resource while applying its ad-hoc signature and fails on a dangling link.
 * These optional command aliases are not used by the bundled Agent, so remove
 * only links whose targets cannot be stat'ed; intact links are left unchanged.
 */
function removeDanglingSymlinks(root) {
  const pending = [root];
  const removed = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        fs.statSync(entryPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        fs.unlinkSync(entryPath);
        removed.push(path.relative(root, entryPath));
      }
    }
  }
  if (removed.length > 0) {
    console.warn(`Removed dangling Python symlinks: ${removed.join(", ")}`);
  }
}

const employeeToken = (process.env.EMPLOYEE_LOOKUP_ADMIN_TOKEN || "").trim();
if (!employeeToken) {
  throw new Error(
    "EMPLOYEE_LOOKUP_ADMIN_TOKEN is required. Add it as a GitHub Actions secret before building.",
  );
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const agentDestination = path.join(outputRoot, "hermes-agent");
copyAgentSource(sourceRepo, agentDestination);
patchCronOutputDirectories(agentDestination);

const presetDestination = path.join(outputRoot, "preset-content");
for (const skillName of presetSkills) {
  const target = path.join(presetDestination, "skills", "custom", skillName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(presetSkillsSource, skillName), target, {
    recursive: true,
  });
}
for (const templateName of presetTemplates) {
  const target = path.join(
    presetDestination,
    "writing-templates",
    templateName,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(path.join(presetTemplatesSource, templateName), target, {
    recursive: true,
  });
}
console.log(
  `Packaged ${presetSkills.length} user Skills and ${presetTemplates.length} writing templates for macOS`,
);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jingyuai-python-"));
const runtimePython = path.join(outputRoot, "python-runtime");
try {
  const archivePath = path.join(temporaryRoot, "python.tar.gz");
  await downloadStandalonePython(archivePath);
  const extractedRoot = path.join(temporaryRoot, "extracted");
  fs.mkdirSync(extractedRoot);
  run("tar", ["-xzf", archivePath, "-C", extractedRoot]);
  const pythonRoot = findPythonRoot(extractedRoot);
  // Preserve relative targets from the archive. Without verbatimSymlinks,
  // Node can rewrite them to absolute paths under `temporaryRoot`; those links
  // look valid here but become dangling as soon as the temporary tree is
  // removed, which later makes Electron Builder's signing walk fail.
  fs.cpSync(pythonRoot, runtimePython, {
    recursive: true,
    verbatimSymlinks: true,
  });

  const basePython = path.join(runtimePython, "bin", "python3");
  const venv = path.join(agentDestination, "venv");
  run(basePython, ["-m", "venv", "--copies", venv]);
  const venvPython = path.join(venv, "bin", "python");
  run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "pip"]);
  // Hermes intentionally rejects ordinary `pip install .`: pip would build a
  // wheel, while Hermes ships as a source checkout with its runtime assets.
  // An editable install is the upstream-supported source-install path. The
  // desktop always launches the bundled `hermes` script with this repository
  // as its working directory, so the copied source remains importable after
  // Electron relocates the runtime into the user's application-data folder.
  run(venvPython, ["-m", "pip", "install", "--disable-pip-version-check", "-e", "."], {
    cwd: agentDestination,
  });
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

// Validate the final relocatable tree only after the extraction directory is
// gone, so links that accidentally retained a temporary target are detected.
removeDanglingSymlinks(runtimePython);

fs.copyFileSync(
  path.join(projectRoot, "resources", "employee-default-soul.md"),
  path.join(outputRoot, "employee-default-soul.md"),
);
fs.writeFileSync(
  path.join(outputRoot, "employee-lookup.env"),
  `EMPLOYEE_LOOKUP_ADMIN_TOKEN=${employeeToken}\n`,
  "utf8",
);
fs.writeFileSync(
  path.join(outputRoot, "desktop-runtime-build.json"),
  `${JSON.stringify({ buildId: randomUUID(), generatedAt: new Date().toISOString() }, null, 2)}\n`,
  "utf8",
);

console.log(`macOS offline runtime staged at ${outputRoot}`);
