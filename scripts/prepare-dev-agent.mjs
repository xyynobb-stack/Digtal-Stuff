import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchDesktopSkillToolsetSource } from "./apply-offline-runtime-overlays.mjs";
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

export function prepareDevAgent() {
  const agentRoot = path.join(hermesHome, "hermes-agent");
  patchCronOutputDirectories(agentRoot);
  ensureDevAgentSkillToolset(agentRoot);
  syncDevMarketReportWorkflowTools(agentRoot);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) prepareDevAgent();
