/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node ESM helper has runtime-validated return values. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  patchDashboardCliColdStartSource,
  patchDashboardColdStartSource,
} from "./patch-dashboard-cold-start.mjs";

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
 * @returns {{agentRoot: string, gatewayServerPath: string, dashboardServerPath: string, dashboardCliPath: string, ttsToolPath: string, desktopMethods: string}}
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
  const dashboardServerPath = path.join(
    agentRoot,
    "hermes_cli",
    "web_server.py",
  );
  const dashboardCliPath = path.join(agentRoot, "hermes_cli", "main.py");
  const ttsToolPath = path.join(agentRoot, "tools", "tts_tool.py");
  if (!fs.existsSync(agentRoot)) {
    throw new Error(`Staged Hermes Agent runtime not found: ${agentRoot}`);
  }
  if (!fs.existsSync(overlayRoot)) {
    throw new Error(`Desktop Agent overlays not found: ${overlayRoot}`);
  }
  if (!fs.existsSync(gatewayServerPath)) {
    throw new Error(`Gateway server not found: ${gatewayServerPath}`);
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

  fs.cpSync(overlayRoot, agentRoot, { recursive: true, force: true });
  const patched = patchGatewayServerSource(
    fs.readFileSync(gatewayServerPath, "utf8"),
  );
  fs.writeFileSync(gatewayServerPath, patched, "utf8");
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
    gatewayServerPath,
    dashboardServerPath,
    dashboardCliPath,
    ttsToolPath,
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
