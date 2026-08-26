import { describe, expect, it, vi } from "vitest";

vi.mock("./installer", () => ({ HERMES_HOME: "C:/tmp/hermes-test" }));
import {
  filterModelsForEmployeeAccess,
  normalizeEmployeeChatModels,
  type EmployeeModelAccess,
} from "./employee-model-access";
import type { SavedModel } from "./models";

const access: EmployeeModelAccess = {
  provider: "custom",
  baseUrl: "http://183.230.227.39:18600/v1/",
  models: ["glm-5.1", "Kimi-2.6"],
  updatedAt: 1,
};

const models: SavedModel[] = [
  {
    id: "glm",
    name: "GLM-5.1",
    provider: "custom",
    model: "glm-5.1",
    baseUrl: "http://183.230.227.39:18600/v1",
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
    baseUrl: "http://183.230.227.39:18600/v1",
    createdAt: 3,
  },
];

describe("employee model access", () => {
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
  it("imports Responses models without treating compact-only as chat", () => {
    const result = normalizeEmployeeChatModels([
      { name: "deepseek-v4-flash", api_formats: ["openai:chat"] },
      {
        name: "gpt-5.6-luna",
        api_formats: ["openai:responses", "openai:responses:compact"],
      },
      { name: "gpt-5.6-terra", api_formats: ["openai:responses"] },
      { name: "compact-only", api_formats: ["openai:responses:compact"] },
      { name: "both", api_formats: ["openai:responses", "openai:chat"] },
    ]);
    expect(result.map(({ model, apiMode }) => [model, apiMode])).toEqual([
      ["deepseek-v4-flash", "chat_completions"],
      ["gpt-5.6-luna", "codex_responses"],
      ["gpt-5.6-terra", "codex_responses"],
      ["both", "chat_completions"],
    ]);
  });

  it("shows only exact models granted for the company endpoint", () => {
    expect(
      filterModelsForEmployeeAccess(models, access).map((model) => model.id),
    ).toEqual(["glm"]);
  });

  it("leaves the normal model library unchanged without an employee grant", () => {
    expect(filterModelsForEmployeeAccess(models, null)).toBe(models);
  });
});
