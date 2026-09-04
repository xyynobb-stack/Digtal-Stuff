import { describe, expect, it } from "vitest";
// @ts-expect-error Plain Node build helper.
import { removeGatewayStartupSource } from "../scripts/remove-gateway-startup-diagnostics.mjs";

describe("gateway diagnostic rollback", () => {
  it("removes retired instrumentation and preserves business calls", () => {
    const source =
      "    from gateway import desktop_startup_diag as _startup_diag\n    _startup_diag.begin()\n    from gateway.run import start_gateway\n    _startup_diag.phase('gateway_module_import.end')\n    result = start_gateway()\n    _startup_diag.finish()\n# desktop-startup-diagnostics-v1\n";
    expect(removeGatewayStartupSource(source)).toBe(
      "    from gateway.run import start_gateway\n    result = start_gateway()\n",
    );
  });
  it("does not touch pristine sources and is idempotent", () => {
    const source = "def start_gateway():\n    return True\n";
    expect(removeGatewayStartupSource(source)).toBe(source);
    expect(removeGatewayStartupSource(removeGatewayStartupSource(source))).toBe(
      source,
    );
  });
});
