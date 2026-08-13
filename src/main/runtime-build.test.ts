import { describe, expect, it } from "vitest";
import { desktopRuntimeBuildIdentity } from "./runtime-build";

describe("desktopRuntimeBuildIdentity", () => {
  it("changes when the desktop version changes with the same staged runtime", () => {
    const marker = '{"buildId":"same-runtime"}';
    expect(desktopRuntimeBuildIdentity(marker, "0.7.11")).not.toBe(
      desktopRuntimeBuildIdentity(marker, "0.7.12"),
    );
  });

  it("is stable for repeated launches of one packaged version", () => {
    const marker = '{"buildId":"runtime-a"}';
    expect(desktopRuntimeBuildIdentity(marker, "0.7.12")).toBe(
      desktopRuntimeBuildIdentity(marker, "0.7.12"),
    );
  });

  it("keeps legacy text markers as opaque build identities", () => {
    expect(desktopRuntimeBuildIdentity("legacy-marker", "0.7.12")).toContain(
      '"runtimeBuild": "legacy-marker"',
    );
  });
});
