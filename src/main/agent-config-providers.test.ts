// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ hermesHome: "" }));

vi.mock("./installer", () => ({
  get HERMES_HOME() {
    return mockState.hermesHome;
  },
}));

describe("agent-config providers (config.yaml bridge)", () => {
  beforeEach(() => {
    mockState.hermesHome = mkdtempSync(join(tmpdir(), "hermes-agent-cfg-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(mockState.hermesHome, { recursive: true, force: true });
  });

  async function mod(): Promise<typeof import("./agent-config-providers")> {
    return import("./agent-config-providers");
  }

  function configPath(): string {
    return join(mockState.hermesHome, "config.yaml");
  }

  function writeConfig(content: string): void {
    writeFileSync(configPath(), content);
  }

  function readConfig(): string {
    return readFileSync(configPath(), "utf-8");
  }

  it("keeps explicit protocol routes separate even with a shared key and URL", async () => {
    const m = await mod();
    const common = {
      baseUrl: "http://company.example/v1",
      keyEnv: "COMPANY_TEST_KEY",
    };
    m.upsertAgentUserProvider(undefined, {
      ...common,
      name: "Company Platform",
      slug: "company-platform",
      apiMode: "chat_completions",
      models: ["deepseek"],
    });
    m.upsertAgentUserProvider(undefined, {
      ...common,
      name: "Company Platform Responses",
      slug: "company-platform-responses",
      apiMode: "codex_responses",
      models: ["gpt-luna", "gpt-terra"],
    });
    const first = readConfig();
    expect(m.listAgentUserProviders()).toHaveLength(2);
    expect(first).toContain('api_mode: "chat_completions"');
    expect(first).toContain('api_mode: "codex_responses"');
    expect(first).toContain('models: ["gpt-luna","gpt-terra"]');
    m.upsertAgentUserProvider(undefined, {
      ...common,
      name: "Company Platform Responses",
      slug: "company-platform-responses",
      apiMode: "codex_responses",
      models: [],
    });
    expect(m.listAgentUserProviders()).toHaveLength(2);
    expect(readConfig()).toContain('models: ["deepseek"]');
    expect(readConfig()).toContain("models: []");
    expect(readConfig()).not.toContain('"gpt-luna"');
  });

  // @lat: [[provider-setup#Provider setup#Agent config sync for named providers#Parses the agent's providers dict]]
  it("parses providers: entries with base_url aliases and key_env", async () => {
    writeConfig(
      [
        "model:",
        '  provider: "custom"',
        "providers:",
        "  faab-ai:",
        '    name: "Faab AI"',
        '    base_url: "https://faab.ai/v1"',
        '    key_env: "FAAB_KEY"',
        "  terse:",
        '    api: "https://terse.example/v1"',
        "gateway:",
        "  port: 9910",
        "",
      ].join("\n"),
    );
    const m = await mod();
    expect(m.listAgentUserProviders("default")).toEqual([
      {
        slug: "faab-ai",
        name: "Faab AI",
        baseUrl: "https://faab.ai/v1",
        keyEnv: "FAAB_KEY",
      },
      {
        slug: "terse",
        name: "terse",
        baseUrl: "https://terse.example/v1",
        keyEnv: "",
      },
    ]);
  });

  it("returns empty for a missing file or absent block", async () => {
    const m = await mod();
    expect(m.listAgentUserProviders("default")).toEqual([]);
    writeConfig("model:\n  provider: nous\n");
    expect(m.listAgentUserProviders("default")).toEqual([]);
  });

  // @lat: [[provider-setup#Provider setup#Agent config sync for named providers#Desktop saves mirror into config.yaml]]
  it("appends a providers: block to an existing config", async () => {
    writeConfig("model:\n  provider: nous\n");
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://faab.ai/v1",
      keyEnv: "CUSTOM_PROVIDER_FAAB_AI_KEY",
    });
    expect(readConfig()).toBe(
      [
        "model:",
        "  provider: nous",
        "providers:",
        "  faab-ai:",
        '    name: "Faab AI"',
        '    base_url: "https://faab.ai/v1"',
        '    key_env: "CUSTOM_PROVIDER_FAAB_AI_KEY"',
        "",
      ].join("\n"),
    );
    expect(m.listAgentUserProviders("default")).toEqual([
      {
        slug: "faab-ai",
        name: "Faab AI",
        baseUrl: "https://faab.ai/v1",
        keyEnv: "CUSTOM_PROVIDER_FAAB_AI_KEY",
      },
    ]);
  });

  // The agent's config scaffold writes `providers: {}` (inline empty dict).
  // The upsert must rewrite that line into block form — this exact miss made
  // the Hermes One mirror a silent no-op on real configs (appending would
  // have produced a duplicate `providers:` key instead).
  it("rewrites an inline empty providers dict into block form", async () => {
    writeConfig(
      [
        "model:",
        "  provider: nous",
        "providers: {}",
        "fallback_providers: []",
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "JingYuAI",
      slug: "hermesone",
      baseUrl: "https://inference.hermesone.org/v1",
      keyEnv: "HERMESONE_API_KEY",
    });
    const content = readConfig();
    // Exactly one providers key, now in block form, siblings untouched.
    expect(content.match(/^providers[^\S\r\n]*:/gm)).toHaveLength(1);
    expect(content).toContain("fallback_providers: []");
    expect(m.listAgentUserProviders("default")).toEqual([
      {
        slug: "hermesone",
        name: "JingYuAI",
        baseUrl: "https://inference.hermesone.org/v1",
        keyEnv: "HERMESONE_API_KEY",
      },
    ]);
  });

  it("adds and idempotently updates the desktop-managed fallback", async () => {
    writeConfig(
      [
        "model:",
        "  provider: company-platform-responses",
        "fallback_providers: []",
        "telemetry: false",
        "",
      ].join("\n"),
    );
    const m = await mod();
    const input = {
      provider: "custom:aihub-responses",
      model: "gpt-5.6-terra",
      baseUrl: "https://aihub.dog/v1",
      keyEnv: "AIHUB_API_KEY",
      apiMode: "codex_responses",
    };
    m.upsertAgentManagedFallback("default", input);
    m.upsertAgentManagedFallback("default", input);
    const content = readConfig();
    expect(
      content.match(/JINGYU_DESKTOP_MANAGED_FALLBACK_BEGIN/g),
    ).toHaveLength(1);
    expect(content).toContain('provider: "custom:aihub-responses"');
    expect(content).toContain('model: "gpt-5.6-terra"');
    expect(content).toContain('api_mode: "codex_responses"');
    expect(content).toContain("telemetry: false");
  });

  it("preserves user fallbacks when appending the managed fallback", async () => {
    writeConfig(
      [
        "fallback_providers:",
        "  - provider: openrouter",
        "    model: existing-model",
        "logging:",
        "  level: info",
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.upsertAgentManagedFallback("default", {
      provider: "custom:aihub-responses",
      model: "gpt-5.6-terra",
      baseUrl: "https://aihub.dog/v1",
      keyEnv: "AIHUB_API_KEY",
      apiMode: "codex_responses",
    });
    const content = readConfig();
    expect(content).toContain("model: existing-model");
    expect(content).toContain('key_env: "AIHUB_API_KEY"');
    expect(content).toContain("logging:\n  level: info");
  });

  it("recovers the fallback after Python removes comments and uses an indentless list", async () => {
    writeConfig(
      [
        "fallback_providers:",
        "- provider: custom:aihub-responses",
        "  model: gpt-5.6-terra",
        "  base_url: https://aihub.dog/v1",
        "  key_env: AIHUB_API_KEY",
        "- provider: existing",
        "  model: keep-me",
        "logging:",
        "  level: info",
        "",
      ].join("\n"),
    );
    const m = await mod();
    const input = {
      provider: "custom:aihub-responses",
      model: "gpt-5.6-terra",
      baseUrl: "https://aihub.dog/v1",
      keyEnv: "AIHUB_API_KEY",
      apiMode: "codex_responses",
    };
    expect(m.upsertAgentManagedFallback("default", input)).toBe(true);
    m.upsertAgentManagedFallback("default", input);
    const content = readConfig();
    expect(content.match(/key_env:.*AIHUB_API_KEY/g)).toHaveLength(1);
    expect(content).toContain("- provider: existing\n  model: keep-me");
    expect(content).toContain("logging:\n  level: info");
  });

  it("does not falsely report success for an unsupported inline fallback list", async () => {
    writeConfig("fallback_providers: [{provider: existing, model: keep}]\n");
    const m = await mod();
    expect(
      m.upsertAgentManagedFallback("default", {
        provider: "custom:aihub-responses",
        model: "gpt-5.6-terra",
        baseUrl: "https://aihub.dog/v1",
        keyEnv: "AIHUB_API_KEY",
        apiMode: "codex_responses",
      }),
    ).toBe(false);
    expect(readConfig()).toContain("model: keep");
  });

  it("only mirrors the AIHub route for a profile with both local credentials", async () => {
    const m = await mod();
    writeConfig("providers: {}\nfallback_providers: []\n");
    const envFile = join(mockState.hermesHome, ".env");
    writeFileSync(envFile, "AIHUB_API_KEY=fake-backup-key\n");
    expect(m.mirrorCompanyFallbackProvider()).toBe(false);
    writeFileSync(
      envFile,
      "AIHUB_API_KEY=fake-backup-key\nCUSTOM_PROVIDER_COMPANY_PLATFORM_KEY=fake-primary-key\n",
    );
    expect(m.mirrorCompanyFallbackProvider()).toBe(true);
    const first = readConfig();
    expect(m.mirrorCompanyFallbackProvider()).toBe(true);
    expect(readConfig()).toBe(first);
    expect(first).not.toContain("fake-backup-key");
    expect(first).not.toContain("fake-primary-key");
  });

  it("never appends a duplicate key over an unparseable flow dict", async () => {
    const before = [
      'providers: { keep: { base_url: "https://keep.example/v1" } }',
      "",
    ].join("\n");
    writeConfig(before);
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "JingYuAI",
      baseUrl: "https://inference.hermesone.org/v1",
      keyEnv: "HERMESONE_API_KEY",
    });
    expect(readConfig()).toBe(before);
  });

  it("creates config.yaml when missing", async () => {
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://faab.ai/v1",
      keyEnv: "CUSTOM_PROVIDER_FAAB_AI_KEY",
    });
    expect(existsSync(configPath())).toBe(true);
    expect(m.listAgentUserProviders("default")).toHaveLength(1);
  });

  it("updates an existing entry in place, preserving extra fields", async () => {
    writeConfig(
      [
        "providers:",
        "  faab-ai:",
        '    name: "Faab AI"',
        '    base_url: "https://old.faab.ai/v1"',
        '    transport: "anthropic_messages"',
        '    key_env: "CUSTOM_PROVIDER_FAAB_AI_KEY"',
        "gateway:",
        "  port: 9910",
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://new.faab.ai/v1",
      keyEnv: "CUSTOM_PROVIDER_FAAB_AI_KEY",
    });
    const content = readConfig();
    expect(content).toContain('base_url: "https://new.faab.ai/v1"');
    // A terminal user's extra field survives the desktop update.
    expect(content).toContain('transport: "anthropic_messages"');
    expect(content).toContain("gateway:");
    expect(m.listAgentUserProviders("default")).toHaveLength(1);
  });

  it.each([
    "    models:\n      - old-model\n",
    "    models:\n    - old-model\n",
    "    models:\n      old-model:\n        context_length: 1000\n",
  ])(
    "replaces Agent-rewritten model blocks without leaving old children: %s",
    async (models) => {
      writeConfig(
        'providers:\n  company-platform:\n    name: "Company Platform"\n' +
          models +
          '    key_env: "SHARED_KEY"\n  other:\n    name: "Keep"\n',
      );
      const m = await mod();
      m.upsertAgentUserProvider("default", {
        slug: "company-platform",
        name: "Company Platform",
        baseUrl: "https://company.example/v1",
        keyEnv: "SHARED_KEY",
        apiMode: "chat_completions",
        models: ["deepseek-v4-flash"],
      });
      const content = readConfig();
      expect(content).toContain(
        '    models: ["deepseek-v4-flash"]\n    key_env: "SHARED_KEY"',
      );
      expect(content).not.toContain("old-model");
      expect(content).not.toContain("context_length");
      expect(content).toContain('  other:\n    name: "Keep"');
      expect(m.listAgentUserProviders("default")).toHaveLength(2);
    },
  );

  it("matches an existing terminal entry by key_env even when slugs differ", async () => {
    writeConfig(
      [
        "providers:",
        "  myfaab:",
        '    name: "Faab"',
        '    base_url: "https://faab.ai/v1"',
        '    key_env: "SHARED_KEY"',
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://faab.ai/v2",
      keyEnv: "SHARED_KEY",
    });
    const list = m.listAgentUserProviders("default");
    // Updated in place under the original slug — no duplicate entry.
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      slug: "myfaab",
      name: "Faab AI",
      baseUrl: "https://faab.ai/v2",
    });
  });

  it("escapes quotes and backslashes in provider values (valid YAML)", async () => {
    // Review regression: unescaped user input inside double-quoted YAML could
    // produce an unparseable config.yaml. The writer escapes, the reader
    // unescapes — the name round-trips exactly.
    const name = 'My "Fast" \\ Provider';
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name,
      baseUrl: "https://fast.example/v1",
      keyEnv: "FAST_KEY",
    });
    expect(readConfig()).toContain('name: "My \\"Fast\\" \\\\ Provider"');
    const list = m.listAgentUserProviders("default");
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe(name);
    // Idempotency survives the escaping: re-upserting is still a no-op.
    const before = readConfig();
    m.upsertAgentUserProvider("default", {
      name,
      baseUrl: "https://fast.example/v1",
      keyEnv: "FAST_KEY",
    });
    expect(readConfig()).toBe(before);
  });

  it("is a no-op re-upserting identical values (no file rewrite)", async () => {
    const m = await mod();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://faab.ai/v1",
      keyEnv: "K",
    });
    const before = readConfig();
    m.upsertAgentUserProvider("default", {
      name: "Faab AI",
      baseUrl: "https://faab.ai/v1",
      keyEnv: "K",
    });
    expect(readConfig()).toBe(before);
  });

  it("removes an entry and leaves siblings intact", async () => {
    writeConfig(
      [
        "providers:",
        "  faab-ai:",
        '    name: "Faab AI"',
        '    base_url: "https://faab.ai/v1"',
        "  other:",
        '    base_url: "https://other.example/v1"',
        "gateway:",
        "  port: 9910",
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.removeAgentUserProvider("default", { name: "Faab AI" });
    const content = readConfig();
    expect(content).not.toContain("faab-ai");
    expect(content).toContain("other:");
    expect(content).toContain("gateway:");
    expect(m.listAgentUserProviders("default")).toHaveLength(1);
  });

  // @lat: [[provider-setup#Provider setup#Agent config sync for named providers#Legacy custom_providers removal]]
  it("removes a legacy custom_providers list item by name", async () => {
    writeConfig(
      [
        "custom_providers:",
        '  - name: "Keep Me"',
        '    base_url: "https://keep.example/v1"',
        '    model: "keep-1"',
        '  - name: "Drop Me"',
        '    base_url: "https://drop.example/v1"',
        '    model: "drop-1"',
        "gateway:",
        "  port: 9910",
        "",
      ].join("\n"),
    );
    const m = await mod();
    m.removeAgentCustomProviderEntry("default", "Drop Me");
    const content = readConfig();
    expect(content).toContain("Keep Me");
    expect(content).not.toContain("Drop Me");
    expect(content).not.toContain("drop.example");
    expect(content).toContain("gateway:");
  });

  it("slugifies display names the way the agent expects", async () => {
    const m = await mod();
    expect(m.slugifyProviderName("Faab AI")).toBe("faab-ai");
    expect(m.slugifyProviderName("  My_Provider 2!  ")).toBe("my-provider-2");
  });
});
