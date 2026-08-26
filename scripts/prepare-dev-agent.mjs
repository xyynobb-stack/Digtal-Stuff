import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchDesktopSkillToolsetSource,
  patchExecuteCodeWindowsChildSource,
} from "./apply-offline-runtime-overlays.mjs";
import { patchCronOutputDirectories } from "./patch-cron-output-directories.mjs";

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
  overlayRoot = path.join(projectRoot, "resources", "hermes-agent-overlays"),
) {
  const source = path.join(
    overlayRoot,
    "skills",
    "research",
    "market-report-rag",
  );
  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    throw new Error(`Market report Skill is missing: ${source}`);
  }
  const targets = [
    path.join(agentRoot, "skills", "research", "market-report-rag"),
    path.join(profileSkillsRoot, "research", "market-report-rag"),
  ];
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
  }
  return true;
}

export function prepareDevAgent() {
  const agentRoot = path.join(hermesHome, "hermes-agent");
  patchCronOutputDirectories(agentRoot);
  ensureDevAgentSkillToolset(agentRoot);
  ensureDevExecuteCodeChildrenHidden(agentRoot);
  syncDevMarketReportWorkflowTools(agentRoot);
  syncDevMarketReportSkill(agentRoot);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) prepareDevAgent();
