import fs from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputRoot = path.join(projectRoot, "build", "offline-runtime");
const hermesHome =
  process.env.HERMES_HOME_SOURCE ||
  path.join(process.env.LOCALAPPDATA || "", "hermes");
const pythonHome = process.env.PYTHON_HOME_SOURCE || "C:\\Python311";
const sourceRepo = path.join(hermesHome, "hermes-agent");
const sourceEnv = path.join(hermesHome, ".env");

if (!fs.existsSync(sourceRepo)) {
  throw new Error(`Hermes agent source not found: ${sourceRepo}`);
}
if (!fs.existsSync(pythonHome)) {
  throw new Error(`Python installation not found: ${pythonHome}`);
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

const excluded = new Set([
  ".git",
  "node_modules",
  "tests",
  "tests-js",
  "docs",
  "website",
  "assets",
  "contributors",
  "__pycache__",
]);
const copyRepo = (src, dest) =>
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (name) => !excluded.has(path.basename(name)),
  });

copyRepo(sourceRepo, path.join(outputRoot, "hermes-agent"));

const browserToolPath = path.join(
  outputRoot,
  "hermes-agent",
  "tools",
  "browser_tool.py",
);
let browserTool = fs.readFileSync(browserToolPath, "utf8").replace(/\r\n/g, "\n");
const browserFunctionsMarker =
  "# ============================================================================\n# Browser Tool Functions\n# ============================================================================\n";
const baiduNavigationHelper = `
def _baidu_navigation_url(value: str) -> str:
    """Use Baidu for browser searches while preserving ordinary URLs."""
    from urllib.parse import parse_qs, quote_plus, urlparse

    raw = (value or "").strip()
    if not raw or raw.lower() in {"about:blank", "chrome://newtab", "chrome://new-tab-page"}:
        return "https://www.baidu.com/"

    if "://" not in raw:
        first_segment = raw.split("/", 1)[0]
        if "." not in first_segment and not first_segment.lower().startswith("localhost"):
            return f"https://www.baidu.com/s?wd={quote_plus(raw)}"
        return raw

    parsed = urlparse(raw)
    host = (parsed.hostname or "").lower()
    search_hosts = (
        host == "google.com"
        or host.endswith(".google.com")
        or host == "bing.com"
        or host.endswith(".bing.com")
        or host == "duckduckgo.com"
        or host.endswith(".duckduckgo.com")
    )
    if not search_hosts:
        return raw

    query = parse_qs(parsed.query).get("q") or parse_qs(parsed.query).get("query")
    if query and query[0].strip():
        return f"https://www.baidu.com/s?wd={quote_plus(query[0].strip())}"
    return "https://www.baidu.com/"


`;
if (!browserTool.includes("def _baidu_navigation_url")) {
  if (!browserTool.includes(browserFunctionsMarker)) {
    throw new Error(`Browser tool patch marker not found: ${browserToolPath}`);
  }
  browserTool = browserTool.replace(
    browserFunctionsMarker,
    `${browserFunctionsMarker}\n${baiduNavigationHelper}`,
  );
}
const navigateDocMarker = "    # Secret exfiltration protection";
if (!browserTool.includes("    url = _baidu_navigation_url(url)")) {
  if (!browserTool.includes(navigateDocMarker)) {
    throw new Error(`Browser navigation marker not found: ${browserToolPath}`);
  }
  browserTool = browserTool.replace(
    navigateDocMarker,
    `    url = _baidu_navigation_url(url)\n\n${navigateDocMarker}`,
  );
}
browserTool = browserTool.replace(
  "The URL to navigate to (e.g., 'https://example.com')",
  "The URL or search keywords. Search keywords and common search-engine URLs open with Baidu by default.",
);
fs.writeFileSync(browserToolPath, browserTool, "utf8");

fs.cpSync(pythonHome, path.join(outputRoot, "python-runtime"), {
  recursive: true,
  filter: (name) =>
    !["__pycache__", "Lib\site-packages"].includes(path.basename(name)),
});

const envText = fs.existsSync(sourceEnv)
  ? fs.readFileSync(sourceEnv, "utf8")
  : "";
const tokenMatch = envText.match(
  /^\s*EMPLOYEE_LOOKUP_ADMIN_TOKEN\s*=\s*(.*?)\s*$/m,
);
const lookupToken = tokenMatch?.[1]?.replace(/^['"]|['"]$/g, "").trim();
if (!lookupToken) {
  throw new Error(`EMPLOYEE_LOOKUP_ADMIN_TOKEN not found in ${sourceEnv}`);
}
fs.writeFileSync(
  path.join(outputRoot, "employee-lookup.env"),
  `EMPLOYEE_LOOKUP_ADMIN_TOKEN=${lookupToken}\n`,
  "utf8",
);

// The venv contains the installed third-party packages. Keep it in the
// staged agent tree; installer.ts repairs pyvenv.cfg after relocation.
console.log(`Offline runtime staged at ${outputRoot}`);
