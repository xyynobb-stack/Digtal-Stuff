import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { shouldCopyAgentRuntimeEntry } from "../scripts/offline-runtime-copy-filter.mjs";
import { verifyDashboardWebDist } from "../scripts/verify-dashboard-web-dist.mjs";
import {
  patchDashboardCliColdStartSource,
  patchDashboardColdStartSource,
} from "../scripts/patch-dashboard-cold-start.mjs";
import { patchTtsRequirementsSource } from "../scripts/apply-offline-runtime-overlays.mjs";

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

describe("desktop Agent model-route overlay", () => {
  // @lat: [[model-selection#Stable runtime route identity]]
  it("packages the generic route resolver and stable route id contract", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "resources",
        "hermes-agent-overlays",
        "tui_gateway",
        "methods_desktop_cold_start.py",
      ),
      "utf8",
    );

    expect(source).toContain('@method("model.resolve")');
    expect(source).toContain('identity["route_id"] = "route:v1:"');
    expect(source).toContain('params.get("route_id")');
  });
});

describe("desktop Dashboard cold-start patch", () => {
  // @lat: [[chat-commands#Layered desktop readiness]]
  it("keeps the full messaging gateway out of Desktop liveness", () => {
    const source = `    # Import hermes_cli.gateway eagerly *before* the lifespan yield so the
    # GIL-heavy .pyc compilation and Defender scan cost is absorbed during
    # backend initialisation \u2014 before the server socket accepts probes.
    # On Windows + Python 3.11 the import does not release the GIL, so
    # run_in_executor still froze the event loop for 15-22 s, causing the
    # Desktop's 10-second WebSocket ready-probe to time out (GH-73083).
    _warm_gateway_module()
`;

    const patched = patchDashboardColdStartSource(source);

    expect(patched).toContain('if os.getenv("HERMES_DESKTOP") != "1":');
    expect(patched).toContain("        _warm_gateway_module()");
    expect(patchDashboardColdStartSource(patched)).toBe(patched);
  });

  it("keeps full plugin discovery ahead of non-Desktop binds only", () => {
    const source = `    try:
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
    except Exception as exc:
        # Discovery failures must not block dashboard startup outright —
        # log and proceed; the gate's fail-closed branch will surface
        # the missing-provider state if it matters.
        print(f"⚠ Plugin discovery failed: {exc}", file=sys.stderr)
`;

    const patched = patchDashboardCliColdStartSource(source);

    expect(patched).toContain('if os.getenv("HERMES_DESKTOP") != "1":');
    expect(patched).toContain(
      "Desktop HTTP readiness must not wait for full plugin discovery",
    );
    expect(patchDashboardCliColdStartSource(patched)).toBe(patched);
  });
});

describe("desktop TTS availability patch", () => {
  // @lat: [[main-process#Optional tool availability]]
  it("keeps optional dependency installation out of Agent construction", () => {
    const source = `def check_tts_requirements() -> bool:
    if provider == "edge":
        try:
            _import_edge_tts()
            return True
        except ImportError:
            return _check_neutts_available()
    if provider == "elevenlabs":
        try:
            _import_elevenlabs()
        except ImportError:
            return False
        return bool(_resolve_provider_key("ELEVENLABS_API_KEY", "elevenlabs"))
    if provider == "mistral":
        try:
            _import_mistral_client()
        except ImportError:
            return False
        return bool(_resolve_provider_key("MISTRAL_API_KEY", "mistral"))
`;

    const patched = patchTtsRequirementsSource(source);

    expect(patched).toContain("def _tts_lazy_feature_available");
    expect(patched).toContain('_tts_lazy_feature_available("tts.edge")');
    expect(patched).not.toContain("            _import_edge_tts()");
    expect(patchTtsRequirementsSource(patched)).toBe(patched);
  });

  it("bundles the default Edge provider in both Windows release channels", () => {
    for (const workflow of ["release.yml", "beta-release.yml"]) {
      const source = readFileSync(
        join(process.cwd(), ".github", "workflows", workflow),
        "utf8",
      );
      expect(source).toContain('-e ".[edge-tts]"');
      expect(source).toContain("import hermes_cli, run_agent, edge_tts");
    }
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
