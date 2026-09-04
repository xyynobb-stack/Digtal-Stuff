import fs from "node:fs";
import path from "node:path";

// Remove only the exact lines inserted by the retired v0.7.52 diagnostics.
export function removeGatewayStartupSource(source) {
  if (!source.includes("# desktop-startup-diagnostics-v1")) return source;
  return source
    .split(/(?<=\n)/)
    .filter(
      (line) =>
        !/^\s*(?:from gateway import desktop_startup_diag as _startup_diag|_startup_diag\.(?:begin|finish)\(\)|_startup_diag\.phase\('[a-z_]+\.(?:begin|end|returned)'\)|# desktop-startup-diagnostics-v1)\s*$/.test(
          line,
        ),
    )
    .join("");
}

export function removeGatewayStartupDiagnostics(agentRoot) {
  for (const file of [
    "hermes_cli/gateway.py",
    "gateway/run.py",
    "gateway/platforms/api_server.py",
  ]) {
    const target = path.join(agentRoot, file);
    if (!fs.existsSync(target)) continue;
    const before = fs.readFileSync(target, "utf8");
    const after = removeGatewayStartupSource(before);
    if (after !== before) fs.writeFileSync(target, after);
  }
  const helper = path.join(agentRoot, "gateway/desktop_startup_diag.py");
  if (fs.existsSync(helper)) fs.unlinkSync(helper);
}
