import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { patchCronOutputDirectories } from "./patch-cron-output-directories.mjs";
import { preparePortableGit } from "./prepare-portable-git.mjs";
import { shouldCopyAgentRuntimeEntry } from "./offline-runtime-copy-filter.mjs";
import { verifyDashboardWebDist } from "./verify-dashboard-web-dist.mjs";
import {
  patchDashboardCliColdStartSource,
  patchDashboardColdStartSource,
} from "./patch-dashboard-cold-start.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(projectRoot, "build", "offline-runtime");
const hermesHome =
  process.env.HERMES_HOME_SOURCE ||
  path.join(process.env.LOCALAPPDATA || "", "hermes");
const pythonHome = process.env.PYTHON_HOME_SOURCE || "C:\\Python311";
const sourceRepo = path.join(hermesHome, "hermes-agent");
const sourceEnv = path.join(hermesHome, ".env");
const defaultSoulRules = path.join(
  projectRoot,
  "resources",
  "employee-default-soul.md",
);

if (!fs.existsSync(sourceRepo)) {
  throw new Error(`Hermes agent source not found: ${sourceRepo}`);
}
if (!fs.existsSync(pythonHome)) {
  throw new Error(`Python installation not found: ${pythonHome}`);
}
if (!fs.existsSync(defaultSoulRules)) {
  throw new Error(`Default SOUL rules not found: ${defaultSoulRules}`);
}

fs.mkdirSync(outputRoot, { recursive: true });
for (const entry of fs.readdirSync(outputRoot)) {
  // PortableGit is large and version-pinned. Keep a valid local staging copy
  // so repeated offline builds do not download the same distribution again.
  if (entry === "git") continue;
  fs.rmSync(path.join(outputRoot, entry), { recursive: true, force: true });
}
await preparePortableGit({ destination: path.join(outputRoot, "git") });

const runtimeBuild = {
  buildId: randomUUID(),
  generatedAt: new Date().toISOString(),
};

/** @param {string} src @param {string} dest @returns {void} */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const copyRepo = (src, dest) =>
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (name) => shouldCopyAgentRuntimeEntry(src, name),
  });

copyRepo(sourceRepo, path.join(outputRoot, "hermes-agent"));
// Desktop-owned gateway extensions are copied after the upstream Agent so a
// release build is reproducible and does not depend on which Agent checkout
// happens to be installed on the packaging machine.
const agentOverlayRoot = path.join(
  projectRoot,
  "resources",
  "hermes-agent-overlays",
);
if (fs.existsSync(agentOverlayRoot)) {
  fs.cpSync(agentOverlayRoot, path.join(outputRoot, "hermes-agent"), {
    recursive: true,
  });
}
verifyDashboardWebDist(
  path.join(outputRoot, "hermes-agent", "hermes_cli", "web_dist"),
);
const dashboardServerPath = path.join(
  outputRoot,
  "hermes-agent",
  "hermes_cli",
  "web_server.py",
);
fs.writeFileSync(
  dashboardServerPath,
  patchDashboardColdStartSource(fs.readFileSync(dashboardServerPath, "utf8")),
  "utf8",
);
const dashboardCliPath = path.join(
  outputRoot,
  "hermes-agent",
  "hermes_cli",
  "main.py",
);
fs.writeFileSync(
  dashboardCliPath,
  patchDashboardCliColdStartSource(fs.readFileSync(dashboardCliPath, "utf8")),
  "utf8",
);
patchCronOutputDirectories(path.join(outputRoot, "hermes-agent"));

// Package the builder's profile-local user content separately from the
// managed Agent runtime. The desktop merges these directories into a new
// user's default profile without replacing any same-name local content.
const presetContentRoot = path.join(outputRoot, "preset-content");
const presetSources = [
  {
    source: path.join(hermesHome, "skills", "custom"),
    target: path.join(presetContentRoot, "skills", "custom"),
    include: (entryPath) => fs.existsSync(path.join(entryPath, "SKILL.md")),
    label: "user Skills",
  },
  {
    source: path.join(hermesHome, "writing-templates"),
    target: path.join(presetContentRoot, "writing-templates"),
    include: (entryPath) =>
      fs.existsSync(path.join(entryPath, "metadata.json")),
    label: "writing templates",
  },
];

for (const preset of presetSources) {
  if (!fs.existsSync(preset.source)) {
    console.log(`No ${preset.label} found at ${preset.source}`);
    continue;
  }

  let copied = 0;
  for (const entry of fs.readdirSync(preset.source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const entrySource = path.join(preset.source, entry.name);
    if (!preset.include(entrySource)) continue;
    fs.mkdirSync(preset.target, { recursive: true });
    fs.cpSync(entrySource, path.join(preset.target, entry.name), {
      recursive: true,
    });
    copied += 1;
  }
  console.log(`Packaged ${copied} ${preset.label} from ${preset.source}`);
}

// A cold dashboard session returns before its deferred AIAgent build is done.
// Prevent slash.exec /model from succeeding only inside its worker while the
// live session silently remains on the default model.
const gatewayServerPath = path.join(
  outputRoot,
  "hermes-agent",
  "tui_gateway",
  "server.py",
);
let gatewayServer = fs
  .readFileSync(gatewayServerPath, "utf8")
  .replace(/\r\n/g, "\n");
if (
  !gatewayServer.includes(
    "methods_desktop_cold_start as _methods_desktop_cold_start",
  )
) {
  const importAnchor = `    methods_complete as _methods_complete,`;
  const registerAnchor = `    _methods_tools,\n):`;
  if (
    !gatewayServer.includes(importAnchor) ||
    !gatewayServer.includes(registerAnchor)
  ) {
    throw new Error(
      `Desktop cold-start registration marker not found: ${gatewayServerPath}`,
    );
  }
  gatewayServer = gatewayServer
    .replace(
      importAnchor,
      `${importAnchor}\n    methods_desktop_cold_start as _methods_desktop_cold_start,`,
    )
    .replace(
      registerAnchor,
      `    _methods_tools,\n    _methods_desktop_cold_start,\n):`,
    );
}
const lazyModelMirrorBlock = `        if name == "model" and arg and agent:
            result = _apply_model_switch(sid, session, arg)
            return result.get("warning", "")`;
const readyModelMirrorBlock = `        if name == "model" and arg:
            # session.create returns before the deferred AIAgent build finishes.
            # A slash worker can therefore report a successful /model switch
            # while there is no live gateway agent to mirror it to. Build and
            # wait here so the command cannot become a silent no-op on a cold
            # install or slower machine.
            if agent is None:
                _start_agent_build(sid, session)
                init_error = _wait_agent(session, f"__slash_model_sync__{sid}")
                if init_error:
                    message = str(
                        (init_error.get("error") or {}).get("message")
                        or "agent initialization failed"
                    )
                    return f"live session sync failed: {message}"
                agent = session.get("agent")
            if agent is None:
                return "live session sync failed: agent initialization failed"
            result = _apply_model_switch(sid, session, arg)
            return result.get("warning", "")`;
if (!gatewayServer.includes("A slash worker can therefore report")) {
  if (!gatewayServer.includes(lazyModelMirrorBlock)) {
    throw new Error(
      `Lazy /model mirror patch marker not found: ${gatewayServerPath}`,
    );
  }
  gatewayServer = gatewayServer.replace(
    lazyModelMirrorBlock,
    readyModelMirrorBlock,
  );
}
fs.writeFileSync(gatewayServerPath, gatewayServer, "utf8");

// Desktop chat sends a model-facing skill-selection envelope. Keep that
// control text out of state.db so the renderer can hydrate one clean user
// bubble and session titles remain based on what the employee actually typed.
const runAgentPath = path.join(outputRoot, "hermes-agent", "run_agent.py");
let runAgent = fs.readFileSync(runAgentPath, "utf8").replace(/\r\n/g, "\n");
const skillSelectionBlock = `        if selection:
            set_task_skill_allowlist(
                effective_task_id,
                [name.strip() for name in selection.group(1).split(",") if name.strip()],
            )`;
const skillSelectionPersistenceBlock = `        if selection:
            # The selection envelope is model-facing control data, not text the
            # employee authored. Keep the full envelope for this API turn, but
            # use the clean suffix for state.db/history. This uses the agent's
            # existing persistence override channel, so prompt caching and the
            # current-turn model input remain unchanged.
            _desktop_control_prefix = (
                "Built-in skills are always available to this chat. The listed names are "
                "the only user-added custom skills enabled for this chat. Load and follow "
                "each listed custom skill with the skill_view tool before answering. An "
                "empty list means no custom skills are enabled."
            )
            _desktop_clean_message = user_message[selection.end():]
            _desktop_user_marker = "\\n\\n[User message]\\n"
            if _desktop_clean_message.startswith(_desktop_control_prefix):
                _desktop_marker_idx = _desktop_clean_message.find(_desktop_user_marker)
                if _desktop_marker_idx >= 0:
                    _desktop_clean_message = _desktop_clean_message[
                        _desktop_marker_idx + len(_desktop_user_marker):
                    ]
                    if persist_user_message is None or persist_user_message == user_message:
                        persist_user_message = _desktop_clean_message
            set_task_skill_allowlist(
                effective_task_id,
                [name.strip() for name in selection.group(1).split(",") if name.strip()],
            )`;
if (!runAgent.includes("The selection envelope is model-facing control data")) {
  if (!runAgent.includes(skillSelectionBlock)) {
    throw new Error(
      `Session skill persistence patch marker not found: ${runAgentPath}`,
    );
  }
  runAgent = runAgent.replace(
    skillSelectionBlock,
    skillSelectionPersistenceBlock,
  );
}
runAgent = runAgent.replace(
  `                "Only the listed skills are available to this chat. Load and "
                "follow each listed skill with the skill_view tool before "
                "answering. An empty list means no skills are available."`,
  `                "Built-in skills are always available to this chat. The listed names are "
                "the only user-added custom skills enabled for this chat. Load and follow "
                "each listed custom skill with the skill_view tool before answering. An "
                "empty list means no custom skills are enabled."`,
);
fs.writeFileSync(runAgentPath, runAgent, "utf8");

// Desktop session selection gates only employee-imported custom Skills. The
// bundled/system library must remain discoverable and callable by default.
const skillsToolPath = path.join(
  outputRoot,
  "hermes-agent",
  "tools",
  "skills_tool.py",
);
let skillsTool = fs.readFileSync(skillsToolPath, "utf8").replace(/\r\n/g, "\n");
if (!skillsTool.includes("_USER_ADDED_SKILL_MARKER")) {
  skillsTool = skillsTool
    .replace(
      `_TASK_SKILL_ALLOWLIST_LOCK = threading.Lock()`,
      `_TASK_SKILL_ALLOWLIST_LOCK = threading.Lock()
_USER_ADDED_SKILL_MARKER = ".hermes-desktop-user-added"`,
    )
    .replace(
      `def _task_allows_skill(task_id: Optional[str], name: str) -> bool:
    if not task_id:
        return True`,
      `def _is_user_added_custom_skill(skill_path: Optional[Path]) -> bool:
    if skill_path is None:
        return False
    category = _get_category_from_path(skill_path)
    return (
        (category or "").lower() == "custom"
        or (skill_path.parent / _USER_ADDED_SKILL_MARKER).exists()
    )


def _task_allows_skill(
    task_id: Optional[str], name: str, skill_path: Optional[Path] = None
) -> bool:
    if not _is_user_added_custom_skill(skill_path):
        return True
    if not task_id:
        return True`,
    )
    .replace(
      `                if not _task_allows_skill(task_id, name):
                    continue

                description = frontmatter.get("description", "")`,
      `                category = _get_category_from_path(skill_md)
                if not _task_allows_skill(task_id, name, skill_md):
                    continue

                description = frontmatter.get("description", "")`,
    )
    .replace(
      `
                category = _get_category_from_path(skill_md)

                seen_names.add(name)`,
      `
                seen_names.add(name)`,
    )
    .replace(
      `        if not _task_allows_skill(task_id, name):
            return json.dumps(
                {
                    "success": False,
                    "error": f"Skill '{name}' is not enabled for this chat.",
                    "hint": "Use the desktop SKILL button to enable it for this chat.",
                },
                ensure_ascii=False,
            )

`,
      "",
    )
    .replace(
      `        # Read the file once — reused for platform check and main content below`,
      `        if not _task_allows_skill(task_id, name, skill_md):
            return json.dumps(
                {
                    "success": False,
                    "error": f"Custom skill '{name}' is not enabled for this chat.",
                    "hint": "Use the desktop SKILL button to enable it for this chat.",
                },
                ensure_ascii=False,
            )

        # Read the file once — reused for platform check and main content below`,
    );
}
if (!skillsTool.includes("def _is_user_added_custom_skill")) {
  throw new Error(
    `Custom Skill allowlist patch marker not found: ${skillsToolPath}`,
  );
}
fs.writeFileSync(skillsToolPath, skillsTool, "utf8");

const promptBuilderPath = path.join(
  outputRoot,
  "hermes-agent",
  "agent",
  "prompt_builder.py",
);
let promptBuilder = fs
  .readFileSync(promptBuilderPath, "utf8")
  .replace(/\r\n/g, "\n");
if (!promptBuilder.includes("desktop_custom_skill_gating")) {
  promptBuilder = promptBuilder
    .replace(
      `    if os.environ.get("HERMES_DESKTOP_SESSION_SKILLS_STRICT") == "1":
        return ""`,
      `    desktop_custom_skill_gating = (
        os.environ.get("HERMES_DESKTOP_SESSION_SKILLS_STRICT") == "1"
    )`,
    )
    .replaceAll(
      `            visible_entries.append(entry)`,
      `            if desktop_custom_skill_gating and (
                str(entry.get("category", "")).lower() == "custom"
                or bool(entry.get("user_added"))
            ):
                continue
            visible_entries.append(entry)`,
    );
}
promptBuilder = promptBuilder.replace(
  "_SKILLS_SNAPSHOT_VERSION = 2",
  "_SKILLS_SNAPSHOT_VERSION = 3",
);
if (!promptBuilder.includes('"user_added"')) {
  promptBuilder = promptBuilder.replace(
    `        "conditions": extract_skill_conditions(frontmatter),`,
    `        "conditions": extract_skill_conditions(frontmatter),
        "user_added": (skill_file.parent / ".hermes-desktop-user-added").exists(),`,
  );
}
if (!promptBuilder.includes("desktop_custom_skill_gating")) {
  throw new Error(
    `Custom Skill prompt patch marker not found: ${promptBuilderPath}`,
  );
}
fs.writeFileSync(promptBuilderPath, promptBuilder, "utf8");

const browserToolPath = path.join(
  outputRoot,
  "hermes-agent",
  "tools",
  "browser_tool.py",
);
let browserTool = fs
  .readFileSync(browserToolPath, "utf8")
  .replace(/\r\n/g, "\n");
const browserFunctionsMarker =
  "# ============================================================================\n# Browser Tool Functions\n# ============================================================================\n";
const baiduNavigationHelper = `
def _baidu_navigation_url(value: str) -> str:
    """Use Baidu for browser searches while preserving ordinary URLs."""
    from urllib.parse import parse_qs, quote_plus, urlparse

    raw = (value or "").strip()
    if not raw or raw.lower() in {"about:blank", "chrome://newtab", "chrome://new-tab-page"}:
        return "https://www.baidu.com/"

    if "://" not in raw:
        first_segment = raw.split("/", 1)[0]
        if "." not in first_segment and not first_segment.lower().startswith("localhost"):
            return f"https://www.baidu.com/s?wd={quote_plus(raw)}"
        return raw

    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    search_hosts = (
        host == "google.com"
        or host.endswith(".google.com")
        or host == "bing.com"
        or host.endswith(".bing.com")
        or host == "duckduckgo.com"
        or host.endswith(".duckduckgo.com")
    )
    if not search_hosts:
        return raw

    query = parse_qs(parsed.query).get("q") or parse_qs(parsed.query).get("query")
    if query and query[0].strip():
        return f"https://www.baidu.com/s?wd={quote_plus(query[0].strip())}"
    return "https://www.baidu.com/"


`;
if (!browserTool.includes("def _baidu_navigation_url")) {
  if (!browserTool.includes(browserFunctionsMarker)) {
    throw new Error(`Browser tool patch marker not found: ${browserToolPath}`);
  }
  browserTool = browserTool.replace(
    browserFunctionsMarker,
    `${browserFunctionsMarker}\n${baiduNavigationHelper}`,
  );
}
const navigateDocMarker = "    # Secret exfiltration protection";
if (!browserTool.includes("    url = _baidu_navigation_url(url)")) {
  if (!browserTool.includes(navigateDocMarker)) {
    throw new Error(`Browser navigation marker not found: ${browserToolPath}`);
  }
  browserTool = browserTool.replace(
    navigateDocMarker,
    `    url = _baidu_navigation_url(url)\n\n${navigateDocMarker}`,
  );
}
browserTool = browserTool.replace(
  "The URL to navigate to (e.g., 'https://example.com')",
  "The URL or search keywords. Search keywords and common search-engine URLs open with Baidu by default.",
);
fs.writeFileSync(browserToolPath, browserTool, "utf8");

fs.cpSync(pythonHome, path.join(outputRoot, "python-runtime"), {
  recursive: true,
  filter: (name) =>
    !["__pycache__", "Lib\\site-packages"].includes(path.basename(name)),
});

const envText = fs.existsSync(sourceEnv)
  ? fs.readFileSync(sourceEnv, "utf8")
  : "";
const tokenMatch = envText.match(
  /^\s*EMPLOYEE_LOOKUP_ADMIN_TOKEN\s*=\s*(.*?)\s*$/m,
);
const lookupToken = tokenMatch?.[1]?.replace(/^['"]|['"]$/g, "").trim();
if (!lookupToken) {
  throw new Error(`EMPLOYEE_LOOKUP_ADMIN_TOKEN not found in ${sourceEnv}`);
}
fs.writeFileSync(
  path.join(outputRoot, "employee-lookup.env"),
  `EMPLOYEE_LOOKUP_ADMIN_TOKEN=${lookupToken}\n`,
  "utf8",
);

// This is deliberately a small, managed addition rather than a copy of the
// builder's personal SOUL.md. installer.ts appends it once to each user's
// own SOUL.md, preserving any user-specific personality or preferences.
fs.copyFileSync(
  defaultSoulRules,
  path.join(outputRoot, "employee-default-soul.md"),
);

// The desktop compares this marker with the writable installed runtime. A new
// package gets a new build ID, forcing the whole managed Python tree to move
// forward together instead of mixing new entry points with old tool modules.
fs.writeFileSync(
  path.join(outputRoot, "desktop-runtime-build.json"),
  `${JSON.stringify(runtimeBuild, null, 2)}\n`,
  "utf8",
);

// The venv contains the installed third-party packages. Keep it in the
// staged agent tree; installer.ts repairs pyvenv.cfg after relocation.
console.log(`Offline runtime staged at ${outputRoot}`);
