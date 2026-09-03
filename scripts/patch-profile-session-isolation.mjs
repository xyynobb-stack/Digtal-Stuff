/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM build helper has runtime-validated return values. */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

// Canonical desktop patch for the upstream Hermes Agent session runtime.
// Keep this outside build/offline-runtime: that directory is a release staging
// snapshot, while this module is applied both to the installed development
// Agent and to the checked-in runtime snapshot immediately before packaging.
const PATCH_GZIP_BASE64 =
  "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";

const PATCHED_FILES = [
  "agent/title_generator.py",
  "tui_gateway/server.py",
  "tui_gateway/methods_prompt.py",
  "tui_gateway/methods_session.py",
  "tui_gateway/methods_tools.py",
];

function hasProfileSessionIsolation(agentRoot) {
  const requiredByFile = new Map([
    [
      "agent/title_generator.py",
      [
        "session_db_factory: Optional[Callable] = None",
        "with session_db_factory() as scoped_db",
      ],
    ],
    [
      "tui_gateway/methods_prompt.py",
      [
        "with _bound_session_db(",
        "profile=_session_profile(session)",
        "set_secret_scope(build_profile_secret_scope(Path(profile_home)))",
      ],
    ],
    [
      "tui_gateway/methods_session.py",
      [
        '"profile": profile or ""',
        "with _session_db(session) as db",
        "profile=_session_profile(session)",
      ],
    ],
    ["tui_gateway/methods_tools.py", ["with _session_db(session) as db"]],
    [
      "tui_gateway/server.py",
      [
        "def _session_db(session: dict):",
        "def _session_environment(",
        "def _bound_session_db(",
        "_title_db_session = {",
        "session_db_factory=lambda _s=_title_db_session",
      ],
    ],
  ]);
  return [...requiredByFile].every(([relativePath, markers]) => {
    const source = readFileSync(path.join(agentRoot, relativePath), "utf8");
    return markers.every((marker) => source.includes(marker));
  });
}

function completeCompatibleAutoTitlePatch(agentRoot) {
  const serverPath = path.join(agentRoot, "tui_gateway/server.py");
  let source = readFileSync(serverPath, "utf8");
  if (!source.includes("_title_db_session = {")) {
    const identityNeedle =
      /(?<indent>[ \t]*)_title_provider = getattr\(agent, "provider", None\)\r?\n(?<call>[ \t]*)maybe_auto_title\(\r?\n(?<arg>[ \t]*)_get_db\(\),/;
    const identityMatch = source.match(identityNeedle);
    if (identityMatch?.groups) {
      const { indent, call, arg } = identityMatch.groups;
      source = source.replace(
        identityNeedle,
        `${indent}_title_provider = getattr(agent, "provider", None)\n` +
          `${indent}_title_db_session = {\n` +
          `${indent}    "session_key": _title_key,\n` +
          `${indent}    "profile": _session_profile(session),\n` +
          `${indent}    "profile_home": session.get("profile_home"),\n` +
          `${indent}    "cwd": _session_cwd(session),\n` +
          `${indent}    "source": _session_source(session),\n` +
          `${indent}}\n` +
          `${call}maybe_auto_title(\n${arg}None,`,
      );
    }
  }
  if (!source.includes("session_db_factory=lambda _s=_title_db_session")) {
    const validatorNeedle =
      /([ \t]*runtime_validator=lambda: \(\r?\n[ \t]*getattr\(agent, "model", None\) == _title_model\r?\n[ \t]*and getattr\(agent, "provider", None\) == _title_provider\r?\n[ \t]*\),)(\r?\n)(?<indent>[ \t]*)# Push the generated title live/;
    const validatorMatch = source.match(validatorNeedle);
    if (validatorMatch?.groups) {
      const indent = validatorMatch.groups.indent;
      source = source.replace(
        validatorNeedle,
        `$1\n${indent}session_db_factory=lambda _s=_title_db_session: _bound_session_db(\n` +
          `${indent}    _s,\n` +
          `${indent}    session_key=_title_key,\n` +
          `${indent}    cwd=_s.get("cwd"),\n` +
          `${indent}    ui_session_id=sid,\n` +
          `${indent}),\n${indent}# Push the generated title live`,
      );
    }
  }
  writeFileSync(serverPath, source, "utf8");
}

function patchCompatibleModifiedTree(agentRoot, patch) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "jingyu-profile-patch-"));
  try {
    for (const relativePath of PATCHED_FILES) {
      const source = path.join(agentRoot, relativePath);
      const target = path.join(tempRoot, relativePath);
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    runGitApply(tempRoot, ["--reject", "--whitespace=nowarn"], patch);
    completeCompatibleAutoTitlePatch(tempRoot);
    for (const relativePath of PATCHED_FILES) {
      const rejectPath = path.join(tempRoot, `${relativePath}.rej`);
      try {
        unlinkSync(rejectPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    if (!hasProfileSessionIsolation(tempRoot)) return false;
    for (const relativePath of PATCHED_FILES) {
      copyFileSync(
        path.join(tempRoot, relativePath),
        path.join(agentRoot, relativePath),
      );
    }
    return true;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runGitApply(agentRoot, args, patch) {
  const resolvedAgentRoot = path.resolve(agentRoot);
  return spawnSync("git", ["apply", ...args, "-"], {
    cwd: resolvedAgentRoot,
    // build/offline-runtime lives inside this repository. Prevent git apply
    // from discovering the desktop repository above agentRoot, otherwise Git
    // silently skips patch paths that are relative to the Agent tree.
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: path.dirname(resolvedAgentRoot),
    },
    input: patch,
    encoding: "utf8",
  });
}

/**
 * Apply the desktop's Profile/session isolation patch to one Hermes Agent tree.
 * Returns true when files changed and false when the exact patch is present.
 */
export function patchProfileSessionIsolation(agentRoot) {
  const patch = gunzipSync(Buffer.from(PATCH_GZIP_BASE64, "base64"));
  if (hasProfileSessionIsolation(agentRoot)) return false;
  const forwardCheck = runGitApply(agentRoot, ["--check"], patch);
  if (forwardCheck.status === 0) {
    const applied = runGitApply(agentRoot, ["--whitespace=nowarn"], patch);
    if (applied.status !== 0) {
      throw new Error(
        `Could not apply Profile session isolation patch: ${applied.stderr || applied.stdout}`,
      );
    }
    if (!hasProfileSessionIsolation(agentRoot)) {
      throw new Error(
        "Profile session isolation patch applied but validation failed",
      );
    }
    return true;
  }

  const reverseCheck = runGitApply(agentRoot, ["--reverse", "--check"], patch);
  if (reverseCheck.status === 0) return false;

  if (patchCompatibleModifiedTree(agentRoot, patch)) return true;

  throw new Error(
    "Hermes Agent sources do not match either side of the Profile session " +
      `isolation patch. Forward: ${forwardCheck.stderr || forwardCheck.stdout}; ` +
      `reverse: ${reverseCheck.stderr || reverseCheck.stdout}`,
  );
}
