import { rmSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./installer", () => ({
  HERMES_HOME: join(
    process.env.TEMP || "C:\\tmp",
    `hermes-model-access-${process.pid}`,
  ),
}));
import {
  EMPLOYEE_MODEL_ROUTES,
  filterModelsForEmployeeAccess,
  normalizeEmployeeChatModels,
  readEmployeeModelAccess,
  writeEmployeeModelAccess,
  type EmployeeModelAccess,
} from "./employee-model-access";
import type { SavedModel } from "./models";

const access: EmployeeModelAccess = {
  provider: "custom",
  baseUrl: "http://36.212.61.62:18600/v1/",
  models: ["glm-5.1", "Kimi-2.6"],
  updatedAt: 1,
};
const modelAccessTestRoot = join(
  process.env.TEMP || "C:\\tmp",
  `hermes-model-access-${process.pid}`,
);

afterEach(() => {
  for (const profile of ["employee-a", "employee-b"]) {
    rmSync(join(modelAccessTestRoot, "profiles", profile), {
      recursive: true,
      force: true,
    });
  }
});

const models: SavedModel[] = [
  {
    id: "glm",
    name: "GLM-5.1",
    provider: "custom",
    model: "glm-5.1",
    baseUrl: "http://36.212.61.62:18600/v1",
    createdAt: 1,
  },
  {
    id: "kimi-wrong-endpoint",
    name: "Kimi-2.6",
    provider: "custom",
    model: "Kimi-2.6",
    baseUrl: "http://localhost:1234/v1",
    createdAt: 2,
  },
  {
    id: "ungranted",
    name: "Unlisted model",
    provider: "custom",
    model: "unlisted",
    baseUrl: "http://36.212.61.62:18600/v1",
    createdAt: 3,
  },
];

describe("employee model access", () => {
  it("keeps one immutable company route per supported protocol", () => {
    expect(EMPLOYEE_MODEL_ROUTES).toEqual([
      {
        apiMode: "chat_completions",
        slug: "company-platform",
        name: "Company Platform",
      },
      {
        apiMode: "codex_responses",
        slug: "company-platform-responses",
        name: "Company Platform Responses",
      },
      {
        apiMode: "anthropic_messages",
        slug: "company-platform-anthropic",
        name: "Company Platform Anthropic",
      },
    ]);
  });

  it("normalizes the chat-capable models returned by phone lookup", () => {
    expect(
      normalizeEmployeeChatModels([
        {
          name: " glm-5.1 ",
          display_name: " GLM-5.1 ",
          api_formats: ["openai:chat"],
          config: { context_limit: 202_752 },
        },
        {
          name: "glm-5.1",
          display_name: "duplicate",
          api_formats: "openai:chat",
        },
        {
          name: "image-only",
          api_formats: ["openai:image"],
        },
      ]),
    ).toEqual([
      {
        model: "glm-5.1",
        name: "GLM-5.1",
        contextLength: 202_752,
        apiMode: "chat_completions",
      },
    ]);
  });

  // @lat: [[model-selection#Employee phone model allowlist#Mixed employee protocols]]
  it("uses preferred formats and tested family defaults across protocols", () => {
    const result = normalizeEmployeeChatModels([
      { name: "deepseek-v4-flash", api_formats: ["openai:chat"] },
      {
        name: "gpt-5.6-luna",
        api_formats: ["openai:responses", "openai:responses:compact"],
      },
      { name: "gpt-5.6-terra", api_formats: ["openai:responses"] },
      {
        name: "gpt-5.6-sol",
        api_formats: ["openai:chat", "openai:responses"],
      },
      {
        name: "claude-opus-5",
        api_formats: ["claude:messages", "openai:chat", "openai:responses"],
        preferred_api_format: "openai:chat",
      },
      {
        name: "claude-without-native-route",
        api_formats: ["openai:chat", "openai:responses"],
        preferred_api_format: "openai:chat",
      },
      {
        name: "grok-4.6",
        api_formats: ["claude:messages", "openai:chat"],
      },
      {
        name: "catalog-preferred",
        api_formats: ["openai:chat", "openai:responses"],
        preferred_api_format: "openai:responses",
      },
      {
        name: "invalid-preferred",
        api_formats: ["openai:chat"],
        preferred_api_format: "claude:messages",
      },
      { name: "compact-only", api_formats: ["openai:responses:compact"] },
      { name: "both", api_formats: ["openai:responses", "openai:chat"] },
    ]);
    expect(result.map(({ model, apiMode }) => [model, apiMode])).toEqual([
      ["deepseek-v4-flash", "chat_completions"],
      ["gpt-5.6-luna", "codex_responses"],
      ["gpt-5.6-terra", "codex_responses"],
      ["gpt-5.6-sol", "codex_responses"],
      ["claude-opus-5", "anthropic_messages"],
      ["grok-4.6", "chat_completions"],
      ["catalog-preferred", "codex_responses"],
      ["invalid-preferred", "chat_completions"],
      ["both", "chat_completions"],
    ]);
  });

  it.each([
    ["DeepSeek-V4-Flash-Vision-Exp", "openai:chat", "chat_completions"],
    ["Qwen3.8-Flash-Next", "openai:chat", "chat_completions"],
    ["claude-haiku-4-5-20251001", "claude:messages", "anthropic_messages"],
    ["claude-opus-5", "claude:messages", "anthropic_messages"],
    ["claude-sonnet-5", "claude:messages", "anthropic_messages"],
    ["deepseek-v4-flash", "openai:chat", "chat_completions"],
    ["gpt-5.6-luna", "openai:responses", "codex_responses"],
    ["gpt-5.6-sol", "openai:responses", "codex_responses"],
    ["gpt-5.6-terra", "openai:responses", "codex_responses"],
    ["grok-4.5", "openai:chat", "chat_completions"],
    ["grok-4.6", "openai:chat", "chat_completions"],
  ] as const)(
    "routes %s through its preferred protocol",
    (name, preferredApiFormat, expectedApiMode) => {
      expect(
        normalizeEmployeeChatModels([
          {
            name,
            api_formats: ["claude:messages", "openai:chat", "openai:responses"],
            preferred_api_format: preferredApiFormat,
          },
        ])[0]?.apiMode,
      ).toBe(expectedApiMode);
    },
  );

  it("shows only exact models granted for the company endpoint", () => {
    expect(
      filterModelsForEmployeeAccess(models, access).map((model) => model.id),
    ).toEqual(["glm"]);
  });

  it("leaves the normal model library unchanged without an employee grant", () => {
    expect(filterModelsForEmployeeAccess(models, null)).toBe(models);
  });

  it("keeps model grants isolated between employee Profiles", () => {
    // @lat: [[model-selection#Session model override#Employee phone model allowlist#Profile-scoped employee grants]]
    writeEmployeeModelAccess(
      "custom",
      "https://company.example/v1",
      ["model-a"],
      "employee-a",
    );

    expect(readEmployeeModelAccess("employee-a")?.models).toEqual(["model-a"]);
    expect(readEmployeeModelAccess("employee-b")).toBeNull();
  });
});
