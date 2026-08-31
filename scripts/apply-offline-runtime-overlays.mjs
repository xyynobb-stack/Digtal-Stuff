/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM helper has runtime-validated return values. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchCompanyFallbackSafety,
  patchCompanyCodexRetries,
} from "./patch-company-fallback-safety.mjs";
import {
  patchDashboardCliColdStartSource,
  patchDashboardColdStartSource,
} from "./patch-dashboard-cold-start.mjs";
import {
  patchDashboardOutputDirectoryComputeHostSource,
  patchDashboardOutputDirectoryPromptSource,
  patchDashboardOutputDirectoryServerSource,
} from "./patch-dashboard-output-directory.mjs";
import { patchDashboardTextIntegrityTraceSource } from "./patch-dashboard-text-integrity-trace.mjs";
import { patchDesktopDdgsSource } from "./patch-desktop-ddgs.mjs";
import {
  patchApprovalApiServerSource,
  patchApprovalCoreSource,
  patchApprovalPromptSource,
} from "./patch-desktop-approval-bridge.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

export const JINGYU_AGENT_PROMPT_RELATIVE_PATHS = [
  "agent/prompt_builder.py",
  "agent/system_prompt.py",
  "agent/moa_loop.py",
  "hermes_cli/default_soul.py",
  "hermes_cli/doctor.py",
  "hermes_cli/profile_describer.py",
  "docker/SOUL.md",
  "tools/close_terminal_tool.py",
  "tools/focus_pane_tool.py",
  "tools/open_preview_tool.py",
  "tools/read_terminal_tool.py",
];

/** Recover same-endpoint providers by model as well as URL on session resume. */
export function patchDesktopProtocolRoutingSource(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes("HERMES_DESKTOP_MODEL_PROTOCOL_ROUTES"))
    return normalized;
  const signature =
    "def find_custom_provider_identity_by_model(model: str) -> Optional[str]:";
  const serves =
    "    def _entry_serves_model(entry: Dict[str, Any]) -> bool:\n";
  const canonical = "    # 1. Reverse-lookup by endpoint URL.\n";
  if (
    ![signature, serves, canonical].every((anchor) =>
      normalized.includes(anchor),
    )
  ) {
    throw new Error("Desktop model protocol routing markers were not found");
  }
  return normalized
    .replace(
      signature,
      "def find_custom_provider_identity_by_model(model: str, base_url: Optional[str] = None) -> Optional[str]:",
    )
    .replace(
      serves,
      serves +
        `        if base_url:
            entry_url = entry.get("api") or entry.get("url") or entry.get("base_url") or ""
            if _normalize_base_url_for_match(entry_url) != _normalize_base_url_for_match(base_url):
                return False
`,
    )
    .replace(
      canonical,
      `    # HERMES_DESKTOP_MODEL_PROTOCOL_ROUTES: one URL can serve multiple protocols.
    # Preserve the session's model-specific named route before URL-only recovery.
    if base_url and model:
        identity = find_custom_provider_identity_by_model(model, base_url=base_url)
        if identity:
            return identity

` + canonical,
    );
}

/**
 * Give the employee GPT Responses route a neutral desktop User-Agent.
 *
 * The company gateway accepts the same Responses body from ordinary HTTP
 * clients but stalls requests identified as the OpenAI Python SDK. Scope this
 * override to the named Responses route and protocol so the chat-completions
 * route sharing the same base URL (for example DeepSeek) is untouched.
 */
export function patchCompanyResponsesUserAgentSource(source) {
  const marker = "HERMES_DESKTOP_COMPANY_RESPONSES_USER_AGENT";
  if (source.includes(marker)) return source.replace(/\r\n/g, "\n");

  const normalized = source.replace(/\r\n/g, "\n");
  const anchor = `            except Exception:
                logger.debug("custom-provider extra_headers skipped", exc_info=True)
`;
  if (!normalized.includes(anchor)) {
    throw new Error("Company Responses User-Agent patch marker was not found");
  }

  const injection = `${anchor}
        # HERMES_DESKTOP_COMPANY_RESPONSES_USER_AGENT
        # Both employee routes share one gateway URL, so URL-scoped headers
        # would leak into chat_completions. Apply this after generic overrides
        # and only to the named Responses route used by company GPT models.
        if (
            self.provider == "company-platform-responses"
            and self.api_mode == "codex_responses"
        ):
            _desktop_headers = dict(self._client_kwargs.get("default_headers") or {})
            _desktop_headers["User-Agent"] = "JingYu-Desktop"
            self._client_kwargs["default_headers"] = _desktop_headers
`;
  return normalized.replace(anchor, injection);
}

/**
 * Apply the desktop employee-gateway fallback policy to the vendored Agent.
 * The 30-second limit is a no-first-event watchdog, not a total generation
 * timeout, and transparent switching is forbidden once visible text escaped.
 */
export function patchCompanyResponsesFallbackSource(source) {
  const marker = "HERMES_DESKTOP_COMPANY_RESPONSES_FALLBACK";
  if (
    source.includes(marker) ||
    source.includes("JINGYU_COMPANY_FALLBACK_SAFETY_HELPERS_V2")
  )
    return patchCompanyFallbackSafety(source, "helpers");
  const normalized = source.replace(/\r\n/g, "\n");
  const ttfbAnchor = `    _ttfb_timeout = _env_float("HERMES_CODEX_TTFB_TIMEOUT_SECONDS", 120.0)
`;
  const fallbackAnchor = `    if reason in {FailoverReason.rate_limit, FailoverReason.billing, FailoverReason.upstream_rate_limit}:
`;
  const apiModeAnchor = `        # Determine api_mode from provider / base URL / model
        fb_api_mode = "chat_completions"
`;
  if (
    !normalized.includes(ttfbAnchor) ||
    !normalized.includes(fallbackAnchor) ||
    !normalized.includes(apiModeAnchor)
  ) {
    throw new Error("Company Responses fallback patch markers were not found");
  }

  const patched = normalized
    .replace(
      ttfbAnchor,
      `${ttfbAnchor}    # ${marker}: fail over only when the employee gateway emits no SSE event.
    # Do not turn this into a 30s total-response timeout: long, healthy streamed
    # generations must continue once the first event has arrived.
    if (
        getattr(agent, "provider", "") == "company-platform-responses"
        and agent._has_pending_fallback()
    ):
        _ttfb_timeout = 30.0
`,
    )
    .replace(
      fallbackAnchor,
      `    # ${marker}: the managed AIHub route only masks recoverable upstream
    # failures. Authentication, request-shape, context, TLS, and policy errors
    # remain visible, and a partially displayed answer is never mixed with a
    # second provider's continuation.
    if getattr(agent, "provider", "") == "company-platform-responses":
        _visible = agent._strip_think_blocks(
            getattr(agent, "_current_streamed_assistant_text", "") or ""
        ).strip()
        if _visible:
            logger.warning("Desktop fallback suppressed after visible output")
            return False
        _desktop_allowed_reasons = {
            FailoverReason.rate_limit,
            FailoverReason.billing,
            FailoverReason.upstream_rate_limit,
            FailoverReason.overloaded,
            FailoverReason.server_error,
            FailoverReason.timeout,
            FailoverReason.model_not_found,
        }
        if reason is not None and reason not in _desktop_allowed_reasons:
            logger.info("Desktop fallback suppressed for %s", reason.value)
            return False

${fallbackAnchor}`,
    )
    .replace(
      apiModeAnchor,
      `${apiModeAnchor}        _explicit_fb_api_mode = str(fb.get("api_mode") or "").strip()
        if _explicit_fb_api_mode in {
            "chat_completions", "codex_responses", "anthropic_messages", "bedrock_converse"
        }:
            fb_api_mode = _explicit_fb_api_mode
`,
    )
    .replace(
      `        if fb_provider == "openai-codex":
            fb_api_mode = "codex_responses"
`,
      `        if _explicit_fb_api_mode:
            pass
        elif fb_provider == "openai-codex":
            fb_api_mode = "codex_responses"
`,
    );
  return patchCompanyFallbackSafety(patched, "helpers");
}

/** Tighten retry/fallback triggers only for the employee Responses route. */
export function patchCompanyResponsesFallbackLoopSource(source) {
  const marker = "HERMES_DESKTOP_COMPANY_RESPONSES_FALLBACK_LOOP";
  if (
    source.includes(marker) ||
    source.includes("JINGYU_COMPANY_FALLBACK_SAFETY_LOOP_V2")
  )
    return patchCompanyFallbackSafety(source, "loop");
  const normalized = source.replace(/\r\n/g, "\n");
  const shouldFallbackAnchor = `                _should_fallback = (
                    is_rate_limited
                    or (_is_transport_failure and retry_count >= 2)
                )
`;
  if (!normalized.includes(shouldFallbackAnchor)) {
    throw new Error("Company Responses fallback-loop marker was not found");
  }
  const patched = normalized
    .replace(
      shouldFallbackAnchor,
      `                # ${marker}: gateway 502/503/504 cannot be repaired by
                # retrying the same upstream. A 500 or transport failure gets
                # one quick retry; rate limits keep their existing fast path.
                _desktop_company_route = (
                    getattr(agent, "provider", "") == "company-platform-responses"
                )
                _desktop_fast_gateway_failure = (
                    _desktop_company_route and status_code in {502, 503, 504}
                )
                _desktop_no_first_event = (
                    _desktop_company_route
                    and classified.reason == FailoverReason.timeout
                    and "ttfb threshold" in str(api_error).lower()
                )
                _desktop_retry_then_fallback = (
                    _desktop_company_route
                    and retry_count >= 2
                    and (
                        status_code == 500
                        or classified.reason == FailoverReason.timeout
                    )
                )
                _should_fallback = (
                    is_rate_limited
                    or _desktop_fast_gateway_failure
                    or _desktop_no_first_event
                    or _desktop_retry_then_fallback
                    or (_is_transport_failure and retry_count >= 2)
                )
`,
    )
    .replace(
      `                    if agent._try_activate_fallback():
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue
                    if api_kwargs is not None:
`,
      `                    if agent._try_activate_fallback(reason=classified.reason):
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue
                    if api_kwargs is not None:
`,
    )
    .replace(
      `                    if agent._try_activate_fallback():
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue
                    # Terminal — flush buffered retry/fallback trace.
`,
      `                    if agent._try_activate_fallback(reason=classified.reason):
                        active_system_prompt = _sync_failover_system_message(
                            agent, api_messages, active_system_prompt)
                        retry_count = 0
                        compression_attempts = 0
                        _retry.primary_recovery_attempted = False
                        continue
                    # Terminal — flush buffered retry/fallback trace.
`,
    );
  return patchCompanyFallbackSafety(patched, "loop");
}

/**
 * Replace only model-visible Hermes identity text with the desktop product
 * identity. Internal compatibility names (HERMES_HOME, the `hermes` CLI, and
 * the `hermes-agent` Skill name) intentionally remain unchanged.
 *
 * @returns {string} Agent source with JingYu-facing identity prompts.
 */
export function patchJingYuAgentIdentitySource(source) {
  const normalized = source
    .replace(/\r\n/g, "\n")
    .replace(/\n# JINGYU_DESKTOP_AGENT_IDENTITY_PROMPTS\n?$/, "\n");

  const replacements = [
    [
      "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
      "You are JingYu Agent, an intelligent AI assistant provided by JingYuAI.",
    ],
    [
      "You are an Agent, an intelligent AI assistant created by Nous Research.",
      "You are JingYu Agent, an intelligent AI assistant provided by JingYuAI.",
    ],
    ["This offline build of Hermes One", "This offline build of JingYu Agent"],
    [
      "You run on Hermes Agent (by Nous Research).",
      "You run on JingYu Agent, the JingYuAI desktop assistant.",
    ],
    [
      "Hermes itself — configuring, setting up, using, extending, or troubleshooting",
      "JingYu Agent itself — configuring, setting up, using, extending, or troubleshooting",
    ],
    [
      "the documentation at https://hermes-agent.nousresearch.com/docs is your authoritative reference",
      "the installed JingYu Agent guidance is your authoritative reference",
    ],
    [
      "You are running in the Hermes terminal UI (TUI).",
      "You are running in the JingYu Agent terminal UI (TUI).",
    ],
    [
      "You are chatting inside the Hermes desktop app —",
      "You are chatting inside the JingYu Agent desktop app —",
    ],
    [
      "You are in the Hermes WebUI, a browser-based chat interface.",
      "You are in the JingYu Agent WebUI, a browser-based chat interface.",
    ],
    ["Active Hermes profile:", "Active JingYu Agent profile:"],
    [
      "or troubleshoot Hermes Agent itself — its CLI, config, models, providers, tools,",
      "or troubleshoot JingYu Agent itself — its CLI, config, models, providers, tools,",
    ],
    [
      "when Hermes has none; explicit Hermes YOLO uses a private unrestricted ",
      "when the Agent has none; explicit unrestricted mode uses a private unrestricted ",
    ],
    [
      "message that Hermes appends to the end of a tool result",
      "message that JingYu Agent appends to the end of a tool result",
    ],
    [
      "where Hermes itself is running. The host OS, home, and cwd ",
      "where JingYu Agent itself is running. The host OS, home, and cwd ",
    ],
    [
      "of the Hermes process are irrelevant; only the following ",
      "of the JingYu Agent process are irrelevant; only the following ",
    ],
    ["on the machine where Hermes ", "on the machine where JingYu Agent "],
    [
      "You are Hermes, a helpful AI assistant.",
      "You are JingYu Agent, a helpful AI assistant.",
    ],
    ["# Hermes Agent Persona", "# JingYu Agent Persona"],
    [
      "Edit this file to customize how Hermes communicates.",
      "Edit this file to customize how JingYu Agent communicates.",
    ],
    ["the main Hermes agent.", "the main JingYu Agent."],
    [
      "Hermes agent. Focus on next steps, tool-use strategy, risks, and any ",
      "JingYu Agent. Focus on next steps, tool-use strategy, risks, and any ",
    ],
    ["normal Hermes agent loop", "normal JingYu Agent loop"],
    [
      "profile-describer for the Hermes Agent kanban board",
      "profile-describer for the JingYu Agent kanban board",
    ],
    [
      'Never write "Hermes Agent profile"',
      'Never write "JingYu Agent profile"',
    ],
    [
      "Reveal and focus a pane in the Hermes desktop app when the user asks to ",
      "Reveal and focus a pane in the JingYu Agent desktop app when the user asks to ",
    ],
    [
      "Open something in the preview pane beside the chat in the Hermes desktop ",
      "Open something in the preview pane beside the chat in the JingYu Agent desktop ",
    ],
    [
      "Read what's currently shown in the in-app terminal pane of the Hermes ",
      "Read what's currently shown in the in-app terminal pane of the JingYu Agent ",
    ],
    [
      "the Hermes desktop GUI (the tabs mirroring terminal(background=true) runs).",
      "the JingYu Agent desktop GUI (the tabs mirroring terminal(background=true) runs).",
    ],
  ];

  let patched = normalized;
  let changed = false;
  for (const [from, to] of replacements) {
    if (!patched.includes(from)) continue;
    patched = patched.replaceAll(from, to);
    changed = true;
  }
  return changed ? patched : normalized;
}

/** @returns {string} Gateway source with the desktop handler module registered. */
export function patchGatewayServerSource(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (
    normalized.includes(
      "methods_desktop_cold_start as _methods_desktop_cold_start",
    )
  ) {
    return normalized;
  }

  const importAnchor = `    methods_complete as _methods_complete,`;
  const registerAnchor = `    _methods_tools,\n):`;
  if (
    !normalized.includes(importAnchor) ||
    !normalized.includes(registerAnchor)
  ) {
    throw new Error("Desktop cold-start registration markers were not found");
  }

  return normalized
    .replace(
      importAnchor,
      `${importAnchor}\n    methods_desktop_cold_start as _methods_desktop_cold_start,`,
    )
    .replace(
      registerAnchor,
      `    _methods_tools,\n    _methods_desktop_cold_start,\n):`,
    );
}

/**
 * Keep the Skills tools on the Desktop/TUI surface when platform defaults are
 * resolved to an explicit toolset list. Without this overlay, the fallback
 * configured-toolset path can omit `skills`, which also suppresses the Skill
 * index from the Agent system prompt.
 *
 * @returns {string} Gateway source with Skills added to implicit Desktop selections.
 */
export function patchDesktopSkillToolsetSource(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (
    normalized.includes('return sorted({*selection, "project", "skills"})') &&
    normalized.includes('return sorted(enabled | {"project", "skills"})')
  ) {
    return normalized;
  }

  const codingAnchor = 'return sorted({*selection, "project"})';
  const configuredAnchor = 'return sorted(enabled | {"project"})';
  if (
    !normalized.includes(codingAnchor) ||
    !normalized.includes(configuredAnchor)
  ) {
    throw new Error("Desktop Skills toolset patch markers were not found");
  }

  return normalized
    .replace(codingAnchor, 'return sorted({*selection, "project", "skills"})')
    .replace(
      configuredAnchor,
      'return sorted(enabled | {"project", "skills"})',
    );
}

/** @returns {string} TTS source whose availability probe never installs packages. */
export function patchTtsRequirementsSource(source) {
  if (
    source.includes("def _tts_lazy_feature_available(feature: str) -> bool:")
  ) {
    return source;
  }
  const normalized = source.replace(/\r\n/g, "\n");

  const functionAnchor = `def check_tts_requirements() -> bool:`;
  const edgeAnchor = `    if provider == "edge":
        try:
            _import_edge_tts()
            return True
        except ImportError:
            return _check_neutts_available()`;
  const elevenLabsAnchor = `    if provider == "elevenlabs":
        try:
            _import_elevenlabs()
        except ImportError:
            return False
        return bool(_resolve_provider_key("ELEVENLABS_API_KEY", "elevenlabs"))`;
  const mistralAnchor = `    if provider == "mistral":
        try:
            _import_mistral_client()
        except ImportError:
            return False
        return bool(_resolve_provider_key("MISTRAL_API_KEY", "mistral"))`;
  for (const anchor of [
    functionAnchor,
    edgeAnchor,
    elevenLabsAnchor,
    mistralAnchor,
  ]) {
    if (!normalized.includes(anchor)) {
      throw new Error("TTS requirements patch markers were not found");
    }
  }

  const pureAvailabilityHelper = `def _tts_lazy_feature_available(feature: str) -> bool:
    """Check an optional TTS dependency without installing or importing it."""
    try:
        from tools.lazy_deps import is_available

        return bool(is_available(feature))
    except Exception:
        return False


`;

  return normalized
    .replace(functionAnchor, `${pureAvailabilityHelper}${functionAnchor}`)
    .replace(
      edgeAnchor,
      `    if provider == "edge":
        return _tts_lazy_feature_available("tts.edge") or _check_neutts_available()`,
    )
    .replace(
      elevenLabsAnchor,
      `    if provider == "elevenlabs":
        return _tts_lazy_feature_available("tts.elevenlabs") and bool(
            _resolve_provider_key("ELEVENLABS_API_KEY", "elevenlabs")
        )`,
    )
    .replace(
      mistralAnchor,
      `    if provider == "mistral":
        return _tts_lazy_feature_available("tts.mistral") and bool(
            _resolve_provider_key("MISTRAL_API_KEY", "mistral")
        )`,
    );
}

/**
 * Make every ordinary process launched from an Execute Code sandbox inherit
 * the Desktop's no-console policy on Windows. The outer sandbox process is
 * already hidden, but model-authored subprocess/os.system calls otherwise
 * create visible cmd.exe or PowerShell windows of their own.
 *
 * @returns {string} Execute Code source with a sandbox-local sitecustomize.
 */
export function patchExecuteCodeWindowsChildSource(source) {
  const marker = "HERMES_DESKTOP_HIDE_CHILD_CONSOLES";
  if (source.includes(marker)) return source;

  const normalized = source.replace(/\r\n/g, "\n");
  const anchor = `        _script_path = os.path.join(tmpdir, "script.py")`;
  if (!normalized.includes(anchor)) {
    throw new Error("Execute Code child-process patch marker was not found");
  }

  const injection = `${anchor}

        # HERMES_DESKTOP_HIDE_CHILD_CONSOLES
        # The sandbox itself uses CREATE_NO_WINDOW, but Windows does not pass
        # that creation flag to grandchildren. sitecustomize is loaded before
        # the model-authored script because tmpdir is first on PYTHONPATH.
        if _IS_WINDOWS:
            _sitecustomize_path = os.path.join(tmpdir, "sitecustomize.py")
            with open(_sitecustomize_path, "w", encoding="utf-8") as _site_file:
                _site_file.write(r'''import os as _os
import subprocess as _subprocess

_hermes_original_popen = _subprocess.Popen

class _HermesHiddenPopen(_hermes_original_popen):
    def __init__(self, *args, **kwargs):
        _flags = int(kwargs.get("creationflags") or 0)
        _flags &= ~int(getattr(_subprocess, "CREATE_NEW_CONSOLE", 0))
        _flags |= int(getattr(_subprocess, "CREATE_NO_WINDOW", 0))
        kwargs["creationflags"] = _flags

        _startup = kwargs.get("startupinfo")
        if _startup is None:
            _startup = _subprocess.STARTUPINFO()
        _startup.dwFlags |= _subprocess.STARTF_USESHOWWINDOW
        _startup.wShowWindow = _subprocess.SW_HIDE
        kwargs["startupinfo"] = _startup
        super().__init__(*args, **kwargs)

_subprocess.Popen = _HermesHiddenPopen

def _hermes_hidden_system(command):
    return _subprocess.call(command, shell=True)

_os.system = _hermes_hidden_system
''')`;

  return normalized.replace(anchor, injection);
}

/**
 * Synchronize repository-owned starter Skills into the staged Runtime preset.
 *
 * Release jobs patch a versioned Runtime checkout instead of rebuilding it
 * from a developer profile, so they must refresh preset-content explicitly.
 */
export function syncRepositoryPresetSkills(
  starterRoot = path.join(projectRoot, "resources", "starter-skills"),
  presetSkillsRoot = path.join(
    projectRoot,
    "build",
    "offline-runtime",
    "preset-content",
    "skills",
    "custom",
  ),
) {
  if (!fs.existsSync(starterRoot)) {
    throw new Error(`Repository starter Skills not found: ${starterRoot}`);
  }
  fs.mkdirSync(presetSkillsRoot, { recursive: true });
  const copied = [];
  for (const entry of fs.readdirSync(starterRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const source = path.join(starterRoot, entry.name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
    const target = path.join(presetSkillsRoot, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, {
      recursive: true,
      filter: (candidate) =>
        !["__pycache__", ".env"].includes(path.basename(candidate)) &&
        !candidate.endsWith(".pyc"),
    });
    copied.push(entry.name);
  }
  return copied;
}

/**
 * @returns {{agentRoot: string, runAgentPath: string, gatewayServerPath: string, dashboardServerPath: string, dashboardCliPath: string, ttsToolPath: string, executeCodeToolPath: string, desktopMethods: string}}
 * Paths for the verified staged overlay.
 */
export function applyOfflineRuntimeOverlays({
  agentRoot = path.join(
    projectRoot,
    "build",
    "offline-runtime",
    "hermes-agent",
  ),
  overlayRoot = path.join(projectRoot, "resources", "hermes-agent-overlays"),
} = {}) {
  syncRepositoryPresetSkills();
  const gatewayServerPath = path.join(agentRoot, "tui_gateway", "server.py");
  const gatewayPromptPath = path.join(
    agentRoot,
    "tui_gateway",
    "methods_prompt.py",
  );
  const computeHostPath = path.join(
    agentRoot,
    "tui_gateway",
    "compute_host.py",
  );
  const dashboardServerPath = path.join(
    agentRoot,
    "hermes_cli",
    "web_server.py",
  );
  const dashboardCliPath = path.join(agentRoot, "hermes_cli", "main.py");
  const ttsToolPath = path.join(agentRoot, "tools", "tts_tool.py");
  const executeCodeToolPath = path.join(
    agentRoot,
    "tools",
    "code_execution_tool.py",
  );
  const approvalToolPath = path.join(agentRoot, "tools", "approval.py");
  const apiServerPath = path.join(
    agentRoot,
    "gateway",
    "platforms",
    "api_server.py",
  );
  const runAgentPath = path.join(agentRoot, "run_agent.py");
  const chatCompletionHelpersPath = path.join(
    agentRoot,
    "agent",
    "chat_completion_helpers.py",
  );
  const conversationLoopPath = path.join(
    agentRoot,
    "agent",
    "conversation_loop.py",
  );
  const codexRuntimePath = path.join(agentRoot, "agent", "codex_runtime.py");
  const ddgsProviderPath = path.join(
    agentRoot,
    "plugins",
    "web",
    "ddgs",
    "provider.py",
  );
  const identityPromptPaths = JINGYU_AGENT_PROMPT_RELATIVE_PATHS.map(
    (relativePath) => path.join(agentRoot, relativePath),
  );
  if (!fs.existsSync(agentRoot)) {
    throw new Error(`Staged Hermes Agent runtime not found: ${agentRoot}`);
  }
  if (!fs.existsSync(overlayRoot)) {
    throw new Error(`Desktop Agent overlays not found: ${overlayRoot}`);
  }
  if (!fs.existsSync(gatewayServerPath)) {
    throw new Error(`Gateway server not found: ${gatewayServerPath}`);
  }
  if (!fs.existsSync(gatewayPromptPath) || !fs.existsSync(computeHostPath)) {
    throw new Error("Gateway output-directory sources were not found");
  }
  if (!fs.existsSync(dashboardServerPath)) {
    throw new Error(`Dashboard server not found: ${dashboardServerPath}`);
  }
  if (!fs.existsSync(dashboardCliPath)) {
    throw new Error(`Dashboard CLI not found: ${dashboardCliPath}`);
  }
  if (!fs.existsSync(ttsToolPath)) {
    throw new Error(`TTS tool not found: ${ttsToolPath}`);
  }
  if (!fs.existsSync(executeCodeToolPath)) {
    throw new Error(`Execute Code tool not found: ${executeCodeToolPath}`);
  }
  if (!fs.existsSync(approvalToolPath) || !fs.existsSync(apiServerPath)) {
    throw new Error("Desktop approval runtime sources were not found");
  }
  if (!fs.existsSync(runAgentPath)) {
    throw new Error(`Agent entrypoint not found: ${runAgentPath}`);
  }
  if (!fs.existsSync(ddgsProviderPath)) {
    throw new Error(`DDGS provider not found: ${ddgsProviderPath}`);
  }
  if (!fs.existsSync(chatCompletionHelpersPath)) {
    throw new Error(
      `Agent chat completion helpers not found: ${chatCompletionHelpersPath}`,
    );
  }
  if (!fs.existsSync(conversationLoopPath)) {
    throw new Error(
      `Agent conversation loop not found: ${conversationLoopPath}`,
    );
  }

  fs.cpSync(overlayRoot, agentRoot, { recursive: true, force: true });
  const runtimeProviderPath = path.join(
    agentRoot,
    "hermes_cli",
    "runtime_provider.py",
  );
  fs.writeFileSync(
    runtimeProviderPath,
    patchDesktopProtocolRoutingSource(
      fs.readFileSync(runtimeProviderPath, "utf8"),
    ),
    "utf8",
  );
  const patched = patchDesktopSkillToolsetSource(
    patchDashboardTextIntegrityTraceSource(
      patchDashboardOutputDirectoryServerSource(
        patchGatewayServerSource(fs.readFileSync(gatewayServerPath, "utf8")),
      ),
    ),
  );
  fs.writeFileSync(gatewayServerPath, patched, "utf8");
  fs.writeFileSync(
    gatewayPromptPath,
    patchDashboardOutputDirectoryPromptSource(
      fs.readFileSync(gatewayPromptPath, "utf8"),
    ),
    "utf8",
  );
  fs.writeFileSync(
    computeHostPath,
    patchDashboardOutputDirectoryComputeHostSource(
      fs.readFileSync(computeHostPath, "utf8"),
    ),
    "utf8",
  );
  fs.writeFileSync(
    dashboardServerPath,
    patchDashboardColdStartSource(fs.readFileSync(dashboardServerPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    dashboardCliPath,
    patchDashboardCliColdStartSource(fs.readFileSync(dashboardCliPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    ttsToolPath,
    patchTtsRequirementsSource(fs.readFileSync(ttsToolPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    executeCodeToolPath,
    patchExecuteCodeWindowsChildSource(
      fs.readFileSync(executeCodeToolPath, "utf8"),
    ),
    "utf8",
  );
  fs.writeFileSync(
    approvalToolPath,
    patchApprovalCoreSource(fs.readFileSync(approvalToolPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    gatewayPromptPath,
    patchApprovalPromptSource(fs.readFileSync(gatewayPromptPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    apiServerPath,
    patchApprovalApiServerSource(fs.readFileSync(apiServerPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    runAgentPath,
    patchCompanyResponsesUserAgentSource(fs.readFileSync(runAgentPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    ddgsProviderPath,
    patchDesktopDdgsSource(fs.readFileSync(ddgsProviderPath, "utf8")),
    "utf8",
  );
  fs.writeFileSync(
    chatCompletionHelpersPath,
    patchCompanyResponsesFallbackSource(
      fs.readFileSync(chatCompletionHelpersPath, "utf8"),
    ),
    "utf8",
  );
  fs.writeFileSync(
    conversationLoopPath,
    patchCompanyResponsesFallbackLoopSource(
      fs.readFileSync(conversationLoopPath, "utf8"),
    ),
    "utf8",
  );
  fs.writeFileSync(
    codexRuntimePath,
    patchCompanyCodexRetries(fs.readFileSync(codexRuntimePath, "utf8")),
    "utf8",
  );
  for (const identityPromptPath of identityPromptPaths) {
    if (!fs.existsSync(identityPromptPath)) continue;
    fs.writeFileSync(
      identityPromptPath,
      patchJingYuAgentIdentitySource(
        fs.readFileSync(identityPromptPath, "utf8"),
      ),
      "utf8",
    );
  }

  const desktopMethods = path.join(
    agentRoot,
    "tui_gateway",
    "methods_desktop_cold_start.py",
  );
  const methodsSource = fs.readFileSync(desktopMethods, "utf8");
  for (const requiredMethod of [
    '@method("model.options")',
    '@method("model.identity")',
    '@method("model.resolve")',
    '@method("session.create")',
    '@method("session.model.set")',
    '@method("session.readiness")',
  ]) {
    if (!methodsSource.includes(requiredMethod)) {
      throw new Error(`Desktop Agent overlay is missing ${requiredMethod}`);
    }
  }

  return {
    agentRoot,
    runAgentPath,
    gatewayServerPath,
    dashboardServerPath,
    dashboardCliPath,
    ttsToolPath,
    executeCodeToolPath,
    desktopMethods,
  };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = applyOfflineRuntimeOverlays({
    ...(process.argv[2] ? { agentRoot: path.resolve(process.argv[2]) } : {}),
  });
  console.log(`Applied desktop Agent overlays to ${result.agentRoot}`);
}
