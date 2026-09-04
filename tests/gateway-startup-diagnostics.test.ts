import { describe, expect, it } from "vitest";
import { patchGatewayStartupSource } from "../scripts/patch-gateway-startup-diagnostics.mjs";

describe("gateway startup diagnostics patch", () => {
  it("instruments CLI import and startup once", () => {
    const source =
      "    from gateway.run import start_gateway\n        success = asyncio.run(start_gateway(replace=replace, verbosity=verbosity))\n";
    const result = patchGatewayStartupSource(source, "cli");
    expect(result).toContain("_startup_diag.begin()");
    expect(result).toContain("start_gateway.begin");
    expect(patchGatewayStartupSource(result, "cli")).toBe(result);
  });
  it("rejects missing and duplicate upstream anchors", () => {
    expect(() => patchGatewayStartupSource("", "run")).toThrow(
      "anchor mismatch",
    );
    expect(() =>
      patchGatewayStartupSource(
        "    from gateway.run import start_gateway\n".repeat(2),
        "cli",
      ),
    ).toThrow("anchor mismatch");
  });
});
