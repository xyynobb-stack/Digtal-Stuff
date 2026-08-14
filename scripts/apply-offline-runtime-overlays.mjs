/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM helper has runtime-validated return values. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");

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
 * @returns {{agentRoot: string, gatewayServerPath: string, desktopMethods: string}}
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
  const gatewayServerPath = path.join(agentRoot, "tui_gateway", "server.py");
  if (!fs.existsSync(agentRoot)) {
    throw new Error(`Staged Hermes Agent runtime not found: ${agentRoot}`);
  }
  if (!fs.existsSync(overlayRoot)) {
    throw new Error(`Desktop Agent overlays not found: ${overlayRoot}`);
  }
  if (!fs.existsSync(gatewayServerPath)) {
    throw new Error(`Gateway server not found: ${gatewayServerPath}`);
  }

  fs.cpSync(overlayRoot, agentRoot, { recursive: true, force: true });
  const patched = patchGatewayServerSource(
    fs.readFileSync(gatewayServerPath, "utf8"),
  );
  fs.writeFileSync(gatewayServerPath, patched, "utf8");

  const desktopMethods = path.join(
    agentRoot,
    "tui_gateway",
    "methods_desktop_cold_start.py",
  );
  const methodsSource = fs.readFileSync(desktopMethods, "utf8");
  for (const requiredMethod of [
    '@method("model.options")',
    '@method("session.create")',
    '@method("session.model.set")',
  ]) {
    if (!methodsSource.includes(requiredMethod)) {
      throw new Error(`Desktop Agent overlay is missing ${requiredMethod}`);
    }
  }

  return { agentRoot, gatewayServerPath, desktopMethods };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = applyOfflineRuntimeOverlays({
    ...(process.argv[2] ? { agentRoot: path.resolve(process.argv[2]) } : {}),
  });
  console.log(`Applied desktop Agent overlays to ${result.agentRoot}`);
}
