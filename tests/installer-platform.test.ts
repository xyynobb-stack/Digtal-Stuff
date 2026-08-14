import { describe, expect, it } from "vitest";
import { delimiter, join } from "path";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import {
  bundledPythonRuntimeLayout,
  bundledPortableGitLayout,
  getEnhancedPath,
  hermesCliArgs,
  managedRuntimePidFiles,
  repairBundledPythonImportPath,
  repairRelocatedRuntime,
  resolveBundledRuntimeRepo,
  validateRuntimeTree,
  HERMES_PYTHON,
  HERMES_SCRIPT,
} from "../src/main/installer";
import { desktopRuntimeVersionName } from "../src/main/runtime-build";

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
    const marker = '{"buildId":"release-test"}\n';
    const expected = join(
      userData,
      "hermes-runtime",
      "versions",
      desktopRuntimeVersionName(marker, "0.7.17"),
      "hermes-agent",
    );

    expect(resolveBundledRuntimeRepo(resources, userData, false)).toBe("");
    expect(resolveBundledRuntimeRepo(resources, userData, true)).toBe("");

    mkdirSync(join(resources, "hermes-runtime", "hermes-agent"), {
      recursive: true,
    });
    writeFileSync(
      join(resources, "hermes-runtime", "desktop-runtime-build.json"),
      marker,
      "utf8",
    );
    expect(resolveBundledRuntimeRepo(resources, userData, true, "0.7.17")).toBe(
      expected,
    );
  });

  it("discovers managed gateway and dashboard PID files across profiles", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-managed-pids-test-"));
    tempRoots.push(root);
    mkdirSync(join(root, "profiles", "work"), { recursive: true });
    writeFileSync(join(root, "gateway.pid"), '{"pid":101}\n', "utf8");
    writeFileSync(
      join(root, "profiles", "work", "dashboard-desktop.pid"),
      '{"pid":202}\n',
      "utf8",
    );

    expect(managedRuntimePidFiles(root)).toEqual([
      { path: join(root, "gateway.pid"), pid: 101 },
      {
        path: join(root, "profiles", "work", "dashboard-desktop.pid"),
        pid: 202,
      },
    ]);
  });

  it("uses the platform path delimiter in the enhanced PATH", () => {
    const enhancedPath = getEnhancedPath();

    expect(enhancedPath).toContain(process.env.PATH || "");
    expect(enhancedPath.split(delimiter).length).toBeGreaterThan(1);
  });

  it("repairs relocated Windows editable installs with a runtime-root pth file", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-python-path-test-"));
    tempRoots.push(root);
    const runtimeRepo = join(root, "hermes-agent");
    mkdirSync(join(runtimeRepo, "venv", "Lib", "site-packages"), {
      recursive: true,
    });

    const sourcePathFile = repairBundledPythonImportPath(runtimeRepo, "win32");

    expect(sourcePathFile).not.toBeNull();
    expect(existsSync(sourcePathFile!)).toBe(true);
    expect(readFileSync(sourcePathFile!, "utf8")).toBe(`${runtimeRepo}\n`);
    expect(repairBundledPythonImportPath(runtimeRepo, "darwin")).toBeNull();
  });

  it("writes final runtime paths into a relocated Windows virtual environment", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-relocated-venv-test-"));
    tempRoots.push(root);
    const runtimeRepo = join(root, "hermes-agent");
    const pythonRoot = join(root, "python-runtime");
    mkdirSync(join(runtimeRepo, "venv", "Lib", "site-packages"), {
      recursive: true,
    });
    mkdirSync(pythonRoot, { recursive: true });
    writeFileSync(
      join(runtimeRepo, "venv", "pyvenv.cfg"),
      "home = C:\\stale\\.staging-runtime\\python-runtime\n" +
        "executable = C:\\stale\\.staging-runtime\\python-runtime\\python.exe\n" +
        "command = C:\\stale\\python.exe -m venv C:\\stale\\venv\n",
      "utf8",
    );

    repairRelocatedRuntime(runtimeRepo, pythonRoot);

    const config = readFileSync(
      join(runtimeRepo, "venv", "pyvenv.cfg"),
      "utf8",
    );
    const layout = bundledPythonRuntimeLayout(pythonRoot, "win32");
    expect(config).toContain(`home = ${layout.home}`);
    expect(config).toContain(`executable = ${layout.executable}`);
    expect(config).toContain(
      `command = ${layout.executable} -m venv ${join(runtimeRepo, "venv")}`,
    );
  });

  it("rejects missing base Python and stale staging paths before activation", () => {
    const root = mkdtempSync(join(tmpdir(), "jingyuai-runtime-validation-"));
    tempRoots.push(root);
    const runtimeRepo = join(root, "hermes-agent");
    const pythonRoot = join(root, "python-runtime");
    const marker = join(root, "desktop-runtime-build.json");
    const identity = "runtime-build-identity\n";
    mkdirSync(join(runtimeRepo, "tui_gateway"), { recursive: true });
    mkdirSync(join(runtimeRepo, "venv", "Scripts"), { recursive: true });
    mkdirSync(join(runtimeRepo, "venv", "Lib", "site-packages"), {
      recursive: true,
    });
    mkdirSync(pythonRoot, { recursive: true });
    writeFileSync(join(runtimeRepo, "tui_gateway", "server.py"), "", "utf8");
    writeFileSync(
      join(runtimeRepo, "venv", "Scripts", "python.exe"),
      "",
      "utf8",
    );
    writeFileSync(
      join(runtimeRepo, "venv", "Scripts", "hermes.exe"),
      "",
      "utf8",
    );
    writeFileSync(marker, identity, "utf8");
    writeFileSync(
      join(runtimeRepo, "venv", "pyvenv.cfg"),
      "home = C:\\old\\.staging-runtime\\python-runtime\n" +
        "executable = C:\\old\\.staging-runtime\\python-runtime\\python.exe\n",
      "utf8",
    );

    expect(
      validateRuntimeTree(
        runtimeRepo,
        pythonRoot,
        marker,
        identity,
        true,
        true,
        "win32",
      ),
    ).toBe("bundled Python executable is missing");

    writeFileSync(join(pythonRoot, "python.exe"), "", "utf8");
    expect(
      validateRuntimeTree(
        runtimeRepo,
        pythonRoot,
        marker,
        identity,
        true,
        true,
        "win32",
      ),
    ).toBe("Python virtual environment points outside the active runtime");

    repairRelocatedRuntime(runtimeRepo, pythonRoot);
    expect(
      validateRuntimeTree(
        runtimeRepo,
        pythonRoot,
        marker,
        identity,
        true,
        true,
        "win32",
      ),
    ).toBeNull();
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
