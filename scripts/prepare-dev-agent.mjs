import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  JINGYU_AGENT_PROMPT_RELATIVE_PATHS,
  patchCompanyResponsesFallbackLoopSource,
  patchCompanyResponsesFallbackSource,
  patchCompanyResponsesUserAgentSource,
  patchDesktopSkillToolsetSource,
  patchExecuteCodeWindowsChildSource,
  patchGatewayServerSource,
  patchDesktopProtocolRoutingSource,
  patchJingYuAgentIdentitySource,
} from "./apply-offline-runtime-overlays.mjs";
import { patchCronOutputDirectories } from "./patch-cron-output-directories.mjs";
import { patchCompanyCodexRetries } from "./patch-company-fallback-safety.mjs";

const hermesHome =
  process.env.HERMES_HOME?.trim() ||
  (process.platform === "win32"
    ? path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "hermes",
      )
    : path.join(os.homedir(), ".hermes"));

const projectRoot = path.resolve(import.meta.dirname, "..");
const workflowToolFiles = [
  "market_report_workflow_state.py",
  "market_report_workflow_tool.py",
];

/** Keep development and packaged model-route RPCs on the same implementation. */
export function syncDevDesktopModelRouting(agentRoot) {
  const gatewayPath = path.join(agentRoot, "tui_gateway", "server.py");
  if (!fs.existsSync(gatewayPath)) return false;
  const source = fs.readFileSync(gatewayPath, "utf8");
  const patched = patchGatewayServerSource(source);
  const runtimeProviderPath = path.join(
    agentRoot,
    "hermes_cli",
    "runtime_provider.py",
  );
  if (fs.existsSync(runtimeProviderPath)) {
    const runtimeSource = fs.readFileSync(runtimeProviderPath, "utf8");
    const runtimePatched = patchDesktopProtocolRoutingSource(runtimeSource);
    if (runtimePatched !== runtimeSource)
      fs.writeFileSync(runtimeProviderPath, runtimePatched, "utf8");
  }
  fs.copyFileSync(
    path.join(
      projectRoot,
      "resources",
      "hermes-agent-overlays",
      "tui_gateway",
      "methods_desktop_cold_start.py",
    ),
    path.join(agentRoot, "tui_gateway", "methods_desktop_cold_start.py"),
  );
  if (patched !== source) fs.writeFileSync(gatewayPath, patched, "utf8");
  return true;
}

/** Ensure the installed development Agent exposes system Skills to every chat. */
export function ensureDevAgentSkillToolset(agentRoot) {
  const gatewayPath = path.join(agentRoot, "tui_gateway", "server.py");
  if (!fs.existsSync(gatewayPath)) return false;

  const source = fs.readFileSync(gatewayPath, "utf8");
  const patched = patchDesktopSkillToolsetSource(source);
  if (patched !== source) fs.writeFileSync(gatewayPath, patched, "utf8");
  return true;
}

/** Keep Execute Code grandchildren hidden in local Windows development. */
export function ensureDevExecuteCodeChildrenHidden(agentRoot) {
  const toolPath = path.join(agentRoot, "tools", "code_execution_tool.py");
  if (!fs.existsSync(toolPath)) return false;

  const source = fs.readFileSync(toolPath, "utf8");
  const patched = patchExecuteCodeWindowsChildSource(source);
  if (patched !== source) fs.writeFileSync(toolPath, patched, "utf8");
  return true;
}

/** Keep the employee GPT Responses request identity stable in development. */
export function ensureDevCompanyResponsesUserAgent(agentRoot) {
  const runAgentPath = path.join(agentRoot, "run_agent.py");
  if (!fs.existsSync(runAgentPath)) return false;

  const source = fs.readFileSync(runAgentPath, "utf8");
  const patched = patchCompanyResponsesUserAgentSource(source);
  if (patched !== source) fs.writeFileSync(runAgentPath, patched, "utf8");
  return true;
}

/** Keep employee-gateway retry and AIHub failover behavior aligned with builds. */
export function ensureDevCompanyResponsesFallback(agentRoot) {
  const helperPath = path.join(
    agentRoot,
    "agent",
    "chat_completion_helpers.py",
  );
  const loopPath = path.join(agentRoot, "agent", "conversation_loop.py");
  if (!fs.existsSync(helperPath) || !fs.existsSync(loopPath)) return false;

  fs.copyFileSync(
    path.join(
      projectRoot,
      "resources/hermes-agent-overlays/agent/desktop_fallback.py",
    ),
    path.join(agentRoot, "agent/desktop_fallback.py"),
  );

  const helperSource = fs.readFileSync(helperPath, "utf8");
  const patchedHelper = patchCompanyResponsesFallbackSource(helperSource);
  if (patchedHelper !== helperSource)
    fs.writeFileSync(helperPath, patchedHelper, "utf8");

  const loopSource = fs.readFileSync(loopPath, "utf8");
  const patchedLoop = patchCompanyResponsesFallbackLoopSource(loopSource);
  if (patchedLoop !== loopSource)
    fs.writeFileSync(loopPath, patchedLoop, "utf8");
  const codexPath = path.join(agentRoot, "agent", "codex_runtime.py");
  if (fs.existsSync(codexPath)) {
    const original = fs.readFileSync(codexPath, "utf8");
    const patched = patchCompanyCodexRetries(original);
    if (original !== patched) fs.writeFileSync(codexPath, patched, "utf8");
  }
  return true;
}

/** Keep model-visible identity text branded as JingYu Agent in development. */
export function ensureDevJingYuAgentIdentity(
  agentRoot,
  profileSoulPath = path.join(hermesHome, "SOUL.md"),
) {
  const promptPaths = [
    ...JINGYU_AGENT_PROMPT_RELATIVE_PATHS.map((relativePath) =>
      path.join(agentRoot, relativePath),
    ),
    profileSoulPath,
  ];
  let found = false;
  for (const promptPath of promptPaths) {
    if (!fs.existsSync(promptPath)) continue;
    found = true;
    const source = fs.readFileSync(promptPath, "utf8");
    const patched = patchJingYuAgentIdentitySource(source);
    if (patched !== source) fs.writeFileSync(promptPath, patched, "utf8");
  }
  return found;
}

/** Copy Desktop-owned report workflow tools into the installed development Agent. */
export function syncDevMarketReportWorkflowTools(
  agentRoot,
  overlayRoot = path.join(projectRoot, "resources", "hermes-agent-overlays"),
) {
  const sourceRoot = path.join(overlayRoot, "tools");
  const targetRoot = path.join(agentRoot, "tools");
  if (!fs.existsSync(targetRoot)) return false;
  fs.mkdirSync(targetRoot, { recursive: true });
  for (const fileName of workflowToolFiles) {
    const source = path.join(sourceRoot, fileName);
    if (!fs.existsSync(source)) {
      throw new Error(`Market report workflow tool is missing: ${source}`);
    }
    fs.copyFileSync(source, path.join(targetRoot, fileName));
  }
  return true;
}

/** Keep the development Agent and its default profile on the canonical Skill. */
export function syncDevMarketReportSkill(
  agentRoot,
  profileSkillsRoot = path.join(hermesHome, "skills"),
  starterRoot = path.join(projectRoot, "resources", "starter-skills"),
) {
  const names = [
    "market-report-rag",
    "hr-analysis-report-rag",
    "finance-analysis-report-rag",
  ];
  for (const name of names) {
    const source = path.join(starterRoot, name);
    if (!fs.existsSync(path.join(source, "SKILL.md"))) {
      throw new Error(`Report Skill is missing: ${source}`);
    }
    const target = path.join(profileSkillsRoot, "custom", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
  }
  fs.rmSync(path.join(agentRoot, "skills", "research", "market-report-rag"), {
    recursive: true,
    force: true,
  });
  const legacyProfileSkill = path.join(
    profileSkillsRoot,
    "research",
    "market-report-rag",
  );
  if (fs.existsSync(legacyProfileSkill)) {
    const backupRoot = path.join(
      path.dirname(profileSkillsRoot),
      "skill-backups",
    );
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.renameSync(
      legacyProfileSkill,
      path.join(
        backupRoot,
        `legacy-research-market-report-rag-${randomUUID()}`,
      ),
    );
  }
  return true;
}

export function prepareDevAgent() {
  const agentRoot = path.join(hermesHome, "hermes-agent");
  syncDevDesktopModelRouting(agentRoot);
  patchCronOutputDirectories(agentRoot);
  ensureDevAgentSkillToolset(agentRoot);
  ensureDevExecuteCodeChildrenHidden(agentRoot);
  ensureDevCompanyResponsesUserAgent(agentRoot);
  ensureDevCompanyResponsesFallback(agentRoot);
  ensureDevJingYuAgentIdentity(agentRoot);
  syncDevMarketReportWorkflowTools(agentRoot);
  syncDevMarketReportSkill(agentRoot);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) prepareDevAgent();
