import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldCopyAgentRuntimeEntry } from "../scripts/offline-runtime-copy-filter.mjs";
import { verifyDashboardWebDist } from "../scripts/verify-dashboard-web-dist.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("offline Agent runtime copy filter", () => {
  it("excludes repository assets but preserves Dashboard build assets", () => {
    const sourceRepo = join("C:\\build", "hermes-agent");

    expect(
      shouldCopyAgentRuntimeEntry(sourceRepo, join(sourceRepo, "assets")),
    ).toBe(false);
    expect(
      shouldCopyAgentRuntimeEntry(
        sourceRepo,
        join(sourceRepo, "hermes_cli", "web_dist", "assets"),
      ),
    ).toBe(true);
    expect(
      shouldCopyAgentRuntimeEntry(
        sourceRepo,
        join(sourceRepo, "web", "node_modules"),
      ),
    ).toBe(false);
  });
});

describe("Dashboard web dist verification", () => {
  function createWebDist(): string {
    const root = mkdtempSync(join(tmpdir(), "dashboard-web-dist-"));
    tempRoots.push(root);
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(
      join(root, "index.html"),
      '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">',
    );
    writeFileSync(join(root, "assets", "app.js"), "export {};\n");
    writeFileSync(join(root, "assets", "app.css"), "body {}\n");
    return root;
  }

  it("accepts a complete Dashboard build", () => {
    const result = verifyDashboardWebDist(createWebDist());

    expect(result.references).toEqual(["assets/app.js", "assets/app.css"]);
  });

  it("rejects a dist whose assets directory was filtered out", () => {
    const root = createWebDist();
    rmSync(join(root, "assets"), { recursive: true, force: true });

    expect(() => verifyDashboardWebDist(root)).toThrow(
      "Dashboard web dist is missing assets directory",
    );
  });

  it("rejects an index that references a missing generated asset", () => {
    const root = createWebDist();
    rmSync(join(root, "assets", "app.js"), { force: true });

    expect(() => verifyDashboardWebDist(root)).toThrow(
      "Dashboard index.html references a missing asset",
    );
  });
});
