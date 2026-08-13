import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PORTABLE_GIT_VERSION = "2.54.0";
const PORTABLE_GIT_TAG = `v${PORTABLE_GIT_VERSION}.windows.1`;

export function portableGitAssetName(arch = process.arch) {
  if (arch === "x64")
    return `PortableGit-${PORTABLE_GIT_VERSION}-64-bit.7z.exe`;
  if (arch === "arm64") {
    return `PortableGit-${PORTABLE_GIT_VERSION}-arm64.7z.exe`;
  }
  throw new Error(`PortableGit is not configured for architecture: ${arch}`);
}

function isComplete(destination) {
  return ["bin/bash.exe", "cmd/git.exe", "usr/bin/cat.exe"].every((entry) =>
    fs.existsSync(path.join(destination, entry)),
  );
}

async function download(url, archive) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3)
        console.log(`Download attempt ${attempt} failed; retrying...`);
    }
  }
  throw new Error(`PortableGit download failed: ${lastError}`);
}

export async function preparePortableGit({
  destination = path.resolve(
    import.meta.dirname,
    "..",
    "build",
    "offline-runtime",
    "git",
  ),
  arch = process.arch,
} = {}) {
  if (process.platform !== "win32") {
    throw new Error("PortableGit staging is supported only on Windows");
  }

  const marker = path.join(destination, "desktop-portable-git.json");
  if (isComplete(destination) && fs.existsSync(marker)) {
    const metadata = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (metadata.version === PORTABLE_GIT_VERSION && metadata.arch === arch) {
      console.log(
        `PortableGit ${PORTABLE_GIT_VERSION} already staged at ${destination}`,
      );
      return destination;
    }
  }

  const localSource =
    process.env.PORTABLE_GIT_SOURCE ||
    (process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "hermes", "git")
      : "");
  if (
    localSource &&
    path.resolve(localSource) !== path.resolve(destination) &&
    isComplete(localSource)
  ) {
    console.log(
      `Copying complete local PortableGit runtime from ${localSource}`,
    );
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(localSource, destination, { recursive: true });
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ version: PORTABLE_GIT_VERSION, arch, source: "local" }, null, 2)}\n`,
      "utf8",
    );
    return destination;
  }

  const asset = portableGitAssetName(arch);
  const url = `https://github.com/git-for-windows/git/releases/download/${PORTABLE_GIT_TAG}/${asset}`;
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "jingyuai-portable-git-"),
  );
  const archive = path.join(temporaryRoot, asset);
  const extractionRoot = path.join(temporaryRoot, "extracted");

  try {
    console.log(`Downloading ${url}`);
    await download(url, archive);
    fs.mkdirSync(extractionRoot, { recursive: true });

    const extraction = spawnSync(archive, [`-o${extractionRoot}`, "-y"], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (extraction.error || extraction.status !== 0) {
      throw (
        extraction.error ||
        new Error(`PortableGit extraction exited ${extraction.status}`)
      );
    }
    if (!isComplete(extractionRoot)) {
      throw new Error("Extracted PortableGit runtime is incomplete");
    }

    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(extractionRoot, destination);
    fs.writeFileSync(
      marker,
      `${JSON.stringify({ version: PORTABLE_GIT_VERSION, arch, asset }, null, 2)}\n`,
      "utf8",
    );
    console.log(`PortableGit staged at ${destination}`);
    return destination;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await preparePortableGit();
