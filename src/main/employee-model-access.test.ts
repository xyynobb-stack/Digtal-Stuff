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
      },
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
