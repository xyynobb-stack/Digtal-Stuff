import { describe, expect, it } from "vitest";
import { delimiter, join } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import {
  bundledPythonRuntimeLayout,
  bundledPortableGitLayout,
  getEnhancedPath,
  hermesCliArgs,
  resolveBundledRuntimeRepo,
  HERMES_PYTHON,
  HERMES_SCRIPT,
} from "../src/main/installer";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("installer platform wiring", () => {
  it("uses the native bundled Python layout for each offline target", () => {
    const windows = bundledPythonRuntimeLayout("C:\\runtime", "win32");
    expect(windows.home).toBe("C:\\runtime");
    expect(windows.executable).toMatch(/python\.exe$/);
    expect(windows.launcherDirectory).toBe("Scripts");

    const mac = bundledPythonRuntimeLayout("/runtime", "darwin");
    expect(mac.home).toBe("/runtime/bin");
    expect(mac.executable).toBe("/runtime/bin/python3");
    expect(mac.launcherDirectory).toBe("bin");
  });

  it("maps packaged PortableGit into the Windows runtime only", () => {
    const windows = bundledPortableGitLayout("C:\\app\\resources", "win32");
    expect(windows?.bash).toMatch(
      /hermes-runtime[\\/]git[\\/]bin[\\/]bash\.exe$/,
    );
    expect(windows?.pathEntries).toHaveLength(3);
    expect(bundledPortableGitLayout("/app/resources", "darwin")).toBeNull();
  });

  it("uses the writable runtime only when a packaged source or prior copy exists", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-runtime-test-"));
    tempRoots.push(root);
    const resources = join(root, "resources");
    const userData = join(root, "user-data");
    const expected = join(userData, "hermes-runtime", "hermes-agent");

    expect(resolveBundledRuntimeRepo(resources, userData, false)).toBe("");
    expect(resolveBundledRuntimeRepo(resources, userData, true)).toBe("");

    mkdirSync(join(resources, "hermes-runtime", "hermes-agent"), {
      recursive: true,
    });
    expect(resolveBundledRuntimeRepo(resources, userData, true)).toBe(expected);
  });

  it("uses the platform path delimiter in the enhanced PATH", () => {
    const enhancedPath = getEnhancedPath();

    expect(enhancedPath).toContain(process.env.PATH || "");
    expect(enhancedPath.split(delimiter).length).toBeGreaterThan(1);
  });

  it("builds platform-specific Hermes CLI invocation args", () => {
    const args = hermesCliArgs(["--version"]);

    if (process.platform === "win32") {
      expect(args).toEqual(["-m", "hermes_cli.main", "--version"]);
      // Use `pythonw.exe` (Windows-subsystem) instead of `python.exe` so
      // child spawns don't flash a blank console window before
      // `windowsHide`/CREATE_NO_WINDOW takes effect — see issue #342.
      expect(HERMES_PYTHON).toMatch(/venv[\\/]Scripts[\\/]pythonw\.exe$/);
      expect(HERMES_SCRIPT).toMatch(/venv[\\/]Scripts[\\/]hermes\.exe$/);
      return;
    }

    expect(args).toEqual([HERMES_SCRIPT, "--version"]);
    expect(HERMES_PYTHON).toMatch(/venv[\\/]bin[\\/]python$/);
  });
});
