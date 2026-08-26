import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldCopyAgentRuntimeEntry } from "../scripts/offline-runtime-copy-filter.mjs";
import { verifyDashboardWebDist } from "../scripts/verify-dashboard-web-dist.mjs";
import {
  patchDashboardCliColdStartSource,
  patchDashboardColdStartSource,
} from "../scripts/patch-dashboard-cold-start.mjs";
import {
  JINGYU_AGENT_PROMPT_RELATIVE_PATHS,
  patchCompanyResponsesFallbackLoopSource,
  patchCompanyResponsesFallbackSource,
  patchCompanyResponsesUserAgentSource,
  patchDesktopSkillToolsetSource,
  patchDesktopProtocolRoutingSource,
  patchExecuteCodeWindowsChildSource,
  patchJingYuAgentIdentitySource,
  patchTtsRequirementsSource,
  syncMarketReportStarterSkill,
} from "../scripts/apply-offline-runtime-overlays.mjs";
import {
  ensureDevCompanyResponsesUserAgent,
  ensureDevCompanyResponsesFallback,
  ensureDevExecuteCodeChildrenHidden,
  ensureDevAgentSkillToolset,
  ensureDevJingYuAgentIdentity,
  syncDevMarketReportSkill,
  syncDevMarketReportWorkflowTools,
  syncDevDesktopModelRouting,
} from "../scripts/prepare-dev-agent.mjs";
import {
  SQLITE_RUNTIME_SHA3_256,
  SQLITE_RUNTIME_VERSION,
  sha3_256,
  sqliteRuntimeAssetName,
  sqliteRuntimeDownloadUrl,
} from "../scripts/prepare-sqlite-runtime.mjs";
import {
  packageOfflineRuntime,
  verifyDesktopSkillToolsetRuntime,
  verifyOfflineRuntimePackage,
} from "../scripts/package-offline-runtime.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("single Runtime archive", () => {
  // @lat: [[main-process#Offline Windows runtime#Single Runtime archive]]
  it("packages and verifies the complete runtime as one opaque payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-runtime-archive-"));
    tempRoots.push(root);
    const runtimeRoot = join(root, "runtime");
    const packageRoot = join(root, "package");
    const required = [
      "hermes-agent/run_agent.py",
      "hermes-agent/tui_gateway/server.py",
      "hermes-agent/hermes_cli/web_dist/index.html",
      "hermes-agent/venv/Scripts/python.exe",
      "hermes-agent/venv/Scripts/hermes.exe",
      "python-runtime/python.exe",
      "python-runtime/DLLs/sqlite3.dll",
      "python-runtime/desktop-sqlite-runtime.json",
      "git/bin/bash.exe",
      "git/cmd/git.exe",
      "employee-lookup.env",
      "desktop-runtime-build.json",
    ];
    for (const relative of required) {
      const target = join(runtimeRoot, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(
        target,
        relative === "hermes-agent/tui_gateway/server.py"
          ? 'return sorted({*selection, "project", "skills"})\nreturn sorted(enabled | {"project", "skills"})\n'
          : `${relative}\n`,
        "utf8",
      );
    }

    const packaged = await packageOfflineRuntime({ runtimeRoot, packageRoot });
    const verified = await verifyOfflineRuntimePackage(packageRoot);

    expect(packaged.manifest.bytes).toBeGreaterThan(0);
    expect(verified.entries.has("hermes-agent/run_agent.py")).toBe(true);
    expect(
      readFileSync(join(packageRoot, "runtime-archive.json"), "utf8"),
    ).toContain(packaged.manifest.sha256);
  });
});

describe("employee Responses fallback overlay", () => {
  it("keeps the managed route on a 30-second no-first-event cutoff", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "build/offline-runtime/hermes-agent/agent/chat_completion_helpers.py",
      ),
      "utf8",
    );
    const patched = patchCompanyResponsesFallbackSource(source);
    expect(patched).toContain(
      "_desktop_fb.expired(_desktop_deadline, _desktop_received)",
    );
    expect(patched).toContain("_desktop_fb.abort_for_fallback");
    expect(patched).toContain("_desktop_fb.allowed(agent, reason)");
    expect(patched).toContain("_explicit_fb_api_mode");
    expect(patchCompanyResponsesFallbackSource(patched)).toBe(patched);
  });

  it("falls back immediately for gateway errors and the 30-second TTFB", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "build/offline-runtime/hermes-agent/agent/conversation_loop.py",
      ),
      "utf8",
    );
    const patched = patchCompanyResponsesFallbackLoopSource(source);
    expect(patched).toContain(
      "_desktop_fb.should_switch(agent, classified, api_error, retry_count)",
    );
    expect(patched).toContain("_desktop_fb.begin_request(agent, retry_count)");
    expect(patched).toContain("_desktop_fb.record_error(agent, api_error)");
    expect(patched).toContain(
      "主线路鉴权或模型/账户权限异常，正在尝试备用线路。",
    );
    expect(patched).toContain(
      'if finish_reason == "content_filter":\n                    agent._desktop_fallback_policy_blocked = True',
    );
    expect(patched).toContain(
      "if _cf_terminated:\n                            agent._desktop_fallback_policy_blocked = True",
    );
    expect(patched).toContain(
      "agent._try_activate_fallback(reason=classified.reason)",
    );
    expect(patchCompanyResponsesFallbackLoopSource(patched)).toBe(patched);
  });

  it("applies both runtime files in development", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-dev-fallback-"));
    tempRoots.push(root);
    const agentDir = join(root, "agent");
    mkdirSync(agentDir, { recursive: true });
    for (const file of ["chat_completion_helpers.py", "conversation_loop.py"]) {
      writeFileSync(
        join(agentDir, file),
        readFileSync(
          join(process.cwd(), "build/offline-runtime/hermes-agent/agent", file),
          "utf8",
        ),
        "utf8",
      );
    }
    expect(ensureDevCompanyResponsesFallback(root)).toBe(true);
  });
});

describe("desktop Agent Skills toolset overlay", () => {
  // @lat: [[chat-commands#Session Skill activation]]
  it("keeps Skills tools in implicit coding and configured selections", () => {
    const source = `
def _load_enabled_toolsets():
    if selection is not None:
        return sorted({*selection, "project"})
    return sorted(enabled | {"project"})
`;

    const patched = patchDesktopSkillToolsetSource(source);

    expect(patched).toContain(
      'return sorted({*selection, "project", "skills"})',
    );
    expect(patched).toContain('return sorted(enabled | {"project", "skills"})');
    expect(patchDesktopSkillToolsetSource(patched)).toBe(patched);
  });

  it("patches the installed development gateway before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-dev-agent-"));
    tempRoots.push(root);
    const gateway = join(root, "tui_gateway", "server.py");
    mkdirSync(join(gateway, ".."), { recursive: true });
    writeFileSync(
      gateway,
      'return sorted({*selection, "project"})\nreturn sorted(enabled | {"project"})\n',
      "utf8",
    );

    expect(ensureDevAgentSkillToolset(root)).toBe(true);
    expect(readFileSync(gateway, "utf8")).toContain(
      'return sorted(enabled | {"project", "skills"})',
    );
  });

  it("is applied by the Windows offline runtime preparation path", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts", "prepare-offline-runtime.mjs"),
      "utf8",
    );

    expect(source).toContain(
      "gatewayServer = patchDesktopSkillToolsetSource(gatewayServer);",
    );
  });

  it("blocks packaging when the staged gateway omits Skills", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-unpatched-agent-"));
    tempRoots.push(root);
    const gateway = join(root, "hermes-agent", "tui_gateway", "server.py");
    mkdirSync(join(gateway, ".."), { recursive: true });
    writeFileSync(
      gateway,
      'return sorted({*selection, "project"})\nreturn sorted(enabled | {"project"})\n',
      "utf8",
    );

    expect(() => verifyDesktopSkillToolsetRuntime(root)).toThrow(
      "missing the required Skills toolset overlay",
    );
  });
});

describe("JingYu Agent identity prompt overlay", () => {
  // @lat: [[main-process#Offline Windows runtime#Model-visible Agent identity]]
  it("changes only model-visible identity wording and is idempotent", () => {
    const source = `
DEFAULT_AGENT_IDENTITY = "You are Hermes Agent, an intelligent AI assistant created by Nous Research."
HERMES_AGENT_HELP_GUIDANCE = "You run on Hermes Agent (by Nous Research). Hermes itself — configuring, setting up, using, extending, or troubleshooting"
TUI = "You are running in the Hermes terminal UI (TUI)."
DESKTOP = "You are chatting inside the Hermes desktop app — a graphical chat"
WEBUI = "You are in the Hermes WebUI, a browser-based chat interface."
PROFILE = "Active Hermes profile: default"
SKILLS = "or troubleshoot Hermes Agent itself — its CLI, config, models, providers, tools,"
SOUL = "You are Hermes, a helpful AI assistant."
LEGACY_SOUL = "You are an Agent, an intelligent AI assistant created by Nous Research. This offline build of Hermes One"
MOA = "Hermes agent. Focus on next steps, tool-use strategy, risks, and any disagreements. normal Hermes agent loop"
PROFILE_DESCRIPTION = "profile-describer for the Hermes Agent kanban board. Never write "Hermes Agent profile""
FOCUS = "Reveal and focus a pane in the Hermes desktop app when the user asks to "
PREVIEW = "Open something in the preview pane beside the chat in the Hermes desktop "
TERMINAL = "Read what's currently shown in the in-app terminal pane of the Hermes desktop GUI"
CLOSE = "the Hermes desktop GUI (the tabs mirroring terminal(background=true) runs)."
`;

    const patched = patchJingYuAgentIdentitySource(source);
    expect(patched).toContain("You are JingYu Agent");
    expect(patched).not.toContain("You are Hermes Agent");
    expect(patched).not.toContain("Active Hermes profile");
    expect(patched).not.toContain("created by Nous Research");
    expect(patched).not.toContain("normal Hermes agent loop");
    expect(patched).not.toContain("Hermes desktop GUI");
    expect(patchJingYuAgentIdentitySource(patched)).toBe(patched);
  });

  it("patches all development prompt sources without touching other files", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-identity-agent-"));
    tempRoots.push(root);
    for (const relative of JINGYU_AGENT_PROMPT_RELATIVE_PATHS) {
      const target = join(root, relative);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(
        target,
        "You are Hermes Agent, an intelligent AI assistant created by Nous Research. Active Hermes profile.\n",
        "utf8",
      );
    }
    const profileSoul = join(root, "profile", "SOUL.md");
    mkdirSync(join(profileSoul, ".."), { recursive: true });
    writeFileSync(
      profileSoul,
      "You are an Agent, an intelligent AI assistant created by Nous Research.\n",
      "utf8",
    );

    expect(ensureDevJingYuAgentIdentity(root, profileSoul)).toBe(true);
    expect(
      readFileSync(join(root, "agent", "prompt_builder.py"), "utf8"),
    ).toContain("JingYu Agent");
    expect(
      readFileSync(join(root, "agent", "system_prompt.py"), "utf8"),
    ).toContain("JingYu Agent");
    expect(
      readFileSync(join(root, "hermes_cli", "default_soul.py"), "utf8"),
    ).toContain("JingYu Agent");
    expect(
      readFileSync(join(root, "hermes_cli", "doctor.py"), "utf8"),
    ).toContain("JingYu Agent");
    expect(readFileSync(join(root, "docker", "SOUL.md"), "utf8")).toContain(
      "JingYu Agent",
    );
    expect(readFileSync(profileSoul, "utf8")).toContain("JingYu Agent");
  });
});

describe("company Responses request identity overlay", () => {
  // @lat: [[provider-setup#Agent config sync for named providers#Company Responses request identity]]
  it("sets JingYu-Desktop only behind the named Responses route guard", () => {
    const source = `
    def _apply_client_headers_for_base_url(self, base_url):
        if self.api_mode not in ("anthropic_messages", "bedrock_converse"):
            try:
                apply_custom_provider_extra_headers_to_client_kwargs(
                    self._client_kwargs, base_url,
                )
            except Exception:
                logger.debug("custom-provider extra_headers skipped", exc_info=True)
`;

    const patched = patchCompanyResponsesUserAgentSource(source);

    expect(patched).toContain('self.provider == "company-platform-responses"');
    expect(patched).toContain('self.api_mode == "codex_responses"');
    expect(patched).toContain(
      '_desktop_headers["User-Agent"] = "JingYu-Desktop"',
    );
    expect(patched).not.toContain("base_url_host_matches");
    expect(patchCompanyResponsesUserAgentSource(patched)).toBe(patched);
  });

  it("patches the installed development Agent before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-dev-agent-"));
    tempRoots.push(root);
    const runAgent = join(root, "run_agent.py");
    writeFileSync(
      runAgent,
      `            except Exception:\n                logger.debug("custom-provider extra_headers skipped", exc_info=True)\n`,
      "utf8",
    );

    expect(ensureDevCompanyResponsesUserAgent(root)).toBe(true);
    expect(readFileSync(runAgent, "utf8")).toContain(
      '_desktop_headers["User-Agent"] = "JingYu-Desktop"',
    );
  });
});

describe("Execute Code Windows child-process overlay", () => {
  // @lat: [[lat.md/main-process#Main Process#Offline Windows runtime#Execute Code descendants stay hidden on Windows]]
  it("injects a sandbox-local no-console policy for subprocess and os.system", () => {
    const source = `
        _mode = _get_execution_mode()
        _child_python = _resolve_child_python(_mode)
        _child_cwd = _resolve_child_cwd(_mode, tmpdir, task_id=task_id or "")
        _script_path = os.path.join(tmpdir, "script.py")

        proc = subprocess.Popen(
`;

    const patched = patchExecuteCodeWindowsChildSource(source);

    expect(patched).toContain("HERMES_DESKTOP_HIDE_CHILD_CONSOLES");
    expect(patched).toContain("CREATE_NO_WINDOW");
    expect(patched).toContain("CREATE_NEW_CONSOLE");
    expect(patched).toContain("_os.system = _hermes_hidden_system");
    expect(patchExecuteCodeWindowsChildSource(patched)).toBe(patched);
  });

  it("patches the installed development Agent before startup", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-dev-execute-code-"));
    tempRoots.push(root);
    const tool = join(root, "tools", "code_execution_tool.py");
    mkdirSync(join(tool, ".."), { recursive: true });
    writeFileSync(
      tool,
      '        _script_path = os.path.join(tmpdir, "script.py")\n',
      "utf8",
    );

    expect(ensureDevExecuteCodeChildrenHidden(root)).toBe(true);
    expect(readFileSync(tool, "utf8")).toContain(
      "HERMES_DESKTOP_HIDE_CHILD_CONSOLES",
    );
  });
});

describe("market report workflow development overlay", () => {
  it("ships the same complete RAG source as an editable user starter without caches", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-rag-starter-"));
    tempRoots.push(root);
    const target = syncMarketReportStarterSkill(root);
    for (const file of [
      "SKILL.md",
      "requirements.txt",
      "scripts/rag_client.py",
      "scripts/embedding_client.py",
      "references/configuration.md",
      "references/report-workflow.md",
    ]) {
      expect(readFileSync(join(target, file), "utf8")).toBe(
        readFileSync(
          join(
            process.cwd(),
            "resources/hermes-agent-overlays/skills/research/market-report-rag",
            file,
          ),
          "utf8",
        ),
      );
    }
    expect(existsSync(join(target, "scripts", "__pycache__"))).toBe(false);
    expect(existsSync(join(target, ".env"))).toBe(false);
    expect(syncMarketReportStarterSkill(root)).toBe(target);
  });
  it("patches model-aware session recovery idempotently for both runtime paths", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "build/offline-runtime/hermes-agent/hermes_cli/runtime_provider.py",
      ),
      "utf8",
    );
    const patched = patchDesktopProtocolRoutingSource(source);
    expect(patched).toContain(
      "find_custom_provider_identity_by_model(model, base_url=base_url)",
    );
    expect(patched).toContain(
      'entry.get("api") or entry.get("url") or entry.get("base_url")',
    );
    expect(patchDesktopProtocolRoutingSource(patched)).toBe(patched);
    expect(
      readFileSync(
        join(process.cwd(), "scripts/prepare-offline-runtime.mjs"),
        "utf8",
      ),
    ).toContain("patchDesktopProtocolRoutingSource(");
  });
  it("synchronizes protocol-aware model routing into the development runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-model-route-"));
    tempRoots.push(root);
    mkdirSync(join(root, "tui_gateway"));
    const gateway = join(root, "tui_gateway", "server.py");
    writeFileSync(
      gateway,
      "    methods_complete as _methods_complete,\n    _methods_tools,\n):\n",
    );
    expect(syncDevDesktopModelRouting(root)).toBe(true);
    expect(syncDevDesktopModelRouting(root)).toBe(true);
    expect(
      readFileSync(gateway, "utf8").match(/methods_desktop_cold_start as/g),
    ).toHaveLength(1);
    expect(
      readFileSync(
        join(root, "tui_gateway", "methods_desktop_cold_start.py"),
        "utf8",
      ),
    ).toBe(
      readFileSync(
        join(
          process.cwd(),
          "resources/hermes-agent-overlays/tui_gateway/methods_desktop_cold_start.py",
        ),
        "utf8",
      ),
    );
  });
  it("copies both state and registry adapter modules into the installed Agent", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-workflow-"));
    tempRoots.push(root);
    const overlay = join(root, "overlay");
    const agent = join(root, "agent");
    mkdirSync(join(overlay, "tools"), { recursive: true });
    mkdirSync(join(agent, "tools"), { recursive: true });
    for (const file of [
      "market_report_workflow_state.py",
      "market_report_workflow_tool.py",
    ]) {
      writeFileSync(join(overlay, "tools", file), file, "utf8");
    }

    expect(syncDevMarketReportWorkflowTools(agent, overlay)).toBe(true);
    expect(
      readFileSync(
        join(agent, "tools", "market_report_workflow_tool.py"),
        "utf8",
      ),
    ).toBe("market_report_workflow_tool.py");
  });

  it("syncs the canonical Skill into the development Agent and profile", () => {
    const root = mkdtempSync(join(tmpdir(), "hermes-report-skill-"));
    tempRoots.push(root);
    const overlay = join(root, "overlay");
    const agent = join(root, "agent");
    const profileSkills = join(root, "profile-skills");
    const sourceSkill = join(
      overlay,
      "skills",
      "research",
      "market-report-rag",
    );
    mkdirSync(sourceSkill, { recursive: true });
    writeFileSync(join(sourceSkill, "SKILL.md"), "canonical", "utf8");

    expect(syncDevMarketReportSkill(agent, profileSkills, overlay)).toBe(true);
    for (const target of [
      join(agent, "skills", "research", "market-report-rag", "SKILL.md"),
      join(profileSkills, "research", "market-report-rag", "SKILL.md"),
    ]) {
      expect(readFileSync(target, "utf8")).toBe("canonical");
    }
  });
});

describe("bundled SQLite runtime", () => {
  // @lat: [[main-process#Offline Windows runtime#Pinned SQLite runtime]]
  it("pins the official x64 archive and release workflow verification", () => {
    expect(SQLITE_RUNTIME_VERSION).toBe("3.53.4");
    expect(SQLITE_RUNTIME_SHA3_256).toBe(
      "deddee963c810d1eeac3ce5e15c7c41da21a1c54d7a39cf54fbf577d2f50de3a",
    );
    expect(sqliteRuntimeAssetName("x64")).toBe(
      "sqlite-dll-win-x64-3530400.zip",
    );
    expect(sqliteRuntimeDownloadUrl("x64")).toBe(
      "https://www.sqlite.org/2026/sqlite-dll-win-x64-3530400.zip",
    );
    expect(sha3_256("abc")).toBe(
      "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532",
    );

    for (const workflow of ["release.yml", "beta-release.yml"]) {
      const source = readFileSync(
        join(process.cwd(), ".github", "workflows", workflow),
        "utf8",
      );
      expect(source).toContain("npm run prepare:sqlite-runtime");
      expect(source).toContain("sqlite3.sqlite_version == '3.53.4'");
      expect(source).toContain("desktop-sqlite-runtime.json");
    }
  });
});

describe("offline Agent runtime copy filter", () => {
  it("excludes repository assets but preserves Dashboard build assets", () => {
    const sourceRepo = join("C:\\build", "hermes-agent");

    expect(
      shouldCopyAgentRuntimeEntry(sourceRepo, join(sourceRepo, "assets")),
    ).toBe(false);
    expect(
      shouldCopyAgentRuntimeEntry(
        sourceRepo,
        join(sourceRepo, "hermes_cli", "web_dist", "assets"),
      ),
    ).toBe(true);
    expect(
      shouldCopyAgentRuntimeEntry(
        sourceRepo,
        join(sourceRepo, "web", "node_modules"),
      ),
    ).toBe(false);
  });
});

describe("desktop Agent model-route overlay", () => {
  // @lat: [[model-selection#Stable runtime route identity]]
  it("packages the generic route resolver and stable route id contract", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "resources",
        "hermes-agent-overlays",
        "tui_gateway",
        "methods_desktop_cold_start.py",
      ),
      "utf8",
    );

    expect(source).toContain('@method("model.resolve")');
    expect(source).toContain('@method("session.readiness")');
    expect(source).toContain('"session.readiness.changed"');
    expect(source).toContain('identity["route_id"] = "route:v1:"');
    expect(source).toContain('params.get("route_id")');
    // @lat: [[model-selection#Latest picker identity wins#Server owns selection generation]]
    expect(source).not.toContain('params.get("selection_generation")');
    expect(source).toContain(
      'server_generation = int(session.get("model_selection_generation", 0)) + 1',
    );
    expect(source).toContain(
      'vars(server)["_append_model_switch_marker"] = _discard_model_switch_marker',
    );
  });
});

describe("desktop Dashboard cold-start patch", () => {
  // @lat: [[chat-commands#Layered desktop readiness]]
  it("keeps the full messaging gateway out of Desktop liveness", () => {
    const source = `    # Import hermes_cli.gateway eagerly *before* the lifespan yield so the
    # GIL-heavy .pyc compilation and Defender scan cost is absorbed during
    # backend initialisation \u2014 before the server socket accepts probes.
    # On Windows + Python 3.11 the import does not release the GIL, so
    # run_in_executor still froze the event loop for 15-22 s, causing the
    # Desktop's 10-second WebSocket ready-probe to time out (GH-73083).
    _warm_gateway_module()
`;

    const patched = patchDashboardColdStartSource(source);

    expect(patched).toContain('if os.getenv("HERMES_DESKTOP") != "1":');
    expect(patched).toContain("        _warm_gateway_module()");
    expect(patchDashboardColdStartSource(patched)).toBe(patched);
  });

  it("keeps full plugin discovery ahead of non-Desktop binds only", () => {
    const source = `    try:
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
    except Exception as exc:
        # Discovery failures must not block dashboard startup outright —
        # log and proceed; the gate's fail-closed branch will surface
        # the missing-provider state if it matters.
        print(f"⚠ Plugin discovery failed: {exc}", file=sys.stderr)
`;

    const patched = patchDashboardCliColdStartSource(source);

    expect(patched).toContain('if os.getenv("HERMES_DESKTOP") != "1":');
    expect(patched).toContain(
      "Desktop HTTP readiness must not wait for full plugin discovery",
    );
    expect(patchDashboardCliColdStartSource(patched)).toBe(patched);
  });
});

describe("desktop TTS availability patch", () => {
  // @lat: [[main-process#Optional tool availability]]
  it("keeps optional dependency installation out of Agent construction", () => {
    const source = `def check_tts_requirements() -> bool:
    if provider == "edge":
        try:
            _import_edge_tts()
            return True
        except ImportError:
            return _check_neutts_available()
    if provider == "elevenlabs":
        try:
            _import_elevenlabs()
        except ImportError:
            return False
        return bool(_resolve_provider_key("ELEVENLABS_API_KEY", "elevenlabs"))
    if provider == "mistral":
        try:
            _import_mistral_client()
        except ImportError:
            return False
        return bool(_resolve_provider_key("MISTRAL_API_KEY", "mistral"))
`;

    const patched = patchTtsRequirementsSource(source);

    expect(patched).toContain("def _tts_lazy_feature_available");
    expect(patched).toContain('_tts_lazy_feature_available("tts.edge")');
    expect(patched).not.toContain("            _import_edge_tts()");
    expect(patchTtsRequirementsSource(patched)).toBe(patched);
  });

  it("bundles the default Edge provider in both Windows release channels", () => {
    for (const workflow of ["release.yml", "beta-release.yml"]) {
      const source = readFileSync(
        join(process.cwd(), ".github", "workflows", workflow),
        "utf8",
      );
      expect(source).toContain('-e ".[edge-tts]"');
      expect(source).toContain("import hermes_cli, run_agent, edge_tts");
    }
  });
});

describe("Dashboard web dist verification", () => {
  function createWebDist(): string {
    const root = mkdtempSync(join(tmpdir(), "dashboard-web-dist-"));
    tempRoots.push(root);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(
      join(root, "index.html"),
      '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">',
    );
    writeFileSync(join(root, "assets", "app.js"), "export {};\n");
    writeFileSync(join(root, "assets", "app.css"), "body {}\n");
    return root;
  }

  it("accepts a complete Dashboard build", () => {
    const result = verifyDashboardWebDist(createWebDist());

    expect(result.references).toEqual(["assets/app.js", "assets/app.css"]);
  });

  it("rejects a dist whose assets directory was filtered out", () => {
    const root = createWebDist();
    rmSync(join(root, "assets"), { recursive: true, force: true });

    expect(() => verifyDashboardWebDist(root)).toThrow(
      "Dashboard web dist is missing assets directory",
    );
  });

  it("rejects an index that references a missing generated asset", () => {
    const root = createWebDist();
    rmSync(join(root, "assets", "app.js"), { force: true });

    expect(() => verifyDashboardWebDist(root)).toThrow(
      "Dashboard index.html references a missing asset",
    );
  });
});
