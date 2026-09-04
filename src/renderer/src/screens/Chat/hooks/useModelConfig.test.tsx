import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useModelConfig } from "./useModelConfig";

const liveDiscoveredModels = vi.hoisted(() => ["live-ollama-model"]);

vi.mock("../../../hooks/useDiscoveredModels", () => ({
  useDiscoveredModels: () => ({
    models: liveDiscoveredModels,
    status: "ok",
  }),
}));

vi.mock("../../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

interface SavedModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  createdAt: number;
}

function Harness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const labels = modelGroups.flatMap((group) =>
    group.models.map((model) => model.label),
  );
  return <output data-testid="models">{JSON.stringify(labels)}</output>;
}

// Exposes the grouping shape (header brand + each model's routing provider) so a
// test can assert brand grouping without changing routing.
function GroupHarness(): React.JSX.Element {
  const { modelGroups } = useModelConfig();
  const shape = modelGroups.map((g) => ({
    provider: g.provider,
    label: g.providerLabel,
    models: g.models.map((m) => ({ model: m.model, provider: m.provider })),
  }));
  return <output data-testid="groups">{JSON.stringify(shape)}</output>;
}

describe("useModelConfig", () => {
  let savedModels: SavedModel[];
  let emitModelLibraryChanged: (() => void) | null;
  let employeeAccessActive: boolean;

  beforeEach(() => {
    savedModels = [
      {
        id: "codex-gpt-55",
        name: "Codex CLI GPT-5.5",
        provider: "codex-cli",
        model: "gpt-5.5",
        baseUrl: "",
        createdAt: 1,
      },
    ];
    emitModelLibraryChanged = null;
    employeeAccessActive = false;

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getModelConfig: vi.fn(async () => ({
          provider: "codex-cli",
          model: "gpt-5.5",
          baseUrl: "",
        })),
        listModels: vi.fn(async () => savedModels),
        getEmployeeModelAccess: vi.fn(async () => ({
          active: employeeAccessActive,
        })),
        onConnectionConfigChanged: vi.fn(() => vi.fn()),
        onModelLibraryChanged: vi.fn((callback: () => void) => {
          emitModelLibraryChanged = callback;
          return vi.fn();
        }),
        setModelConfig: vi.fn(async () => true),
      },
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, "hermesAPI");
  });

  it("reloads the chat picker when the model library changes", async () => {
    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent(
        "Codex CLI GPT-5.5",
      );
    });

    savedModels = [
      ...savedModels,
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "",
        createdAt: 2,
      },
    ];

    await act(async () => {
      emitModelLibraryChanged?.();
    });

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent("DeepSeek V4 Pro");
    });
  });

  it("does not merge live provider models into an employee-restricted catalog", async () => {
    employeeAccessActive = true;
    savedModels = [
      {
        id: "company-glm",
        name: "GLM-5.1",
        provider: "custom",
        model: "glm-5.1",
        baseUrl: "http://36.212.61.62:18600/v1",
        createdAt: 1,
      },
    ];

    render(<Harness />);

    await waitFor(() => {
      expect(screen.getByTestId("models")).toHaveTextContent("GLM-5.1");
      expect(screen.getByTestId("models")).not.toHaveTextContent(
        "live-ollama-model",
      );
    });
  });

  it("groups a custom JingYuAI model under the JingYuAI brand while keeping custom routing", async () => {
    savedModels = [
      {
        id: "hs-swift",
        name: "hermesone-swift",
        provider: "custom",
        model: "hermesone-swift",
        baseUrl: "https://inference.hermesone.org/v1",
        createdAt: 1,
      },
    ];

    render(<GroupHarness />);

    await waitFor(() => {
      const groups = JSON.parse(
        screen.getByTestId("groups").textContent || "[]",
      );
      const hs = groups.find((g: { label: string }) => g.label === "JingYuAI");
      expect(hs).toBeTruthy();
      // Not lumped under the generic OpenAI-compatible bucket.
      expect(hs.provider).toBe("hermesone");
      // Routing stays on `custom` + the base URL so the request still resolves.
      expect(hs.models[0]).toEqual({
        model: "hermesone-swift",
        provider: "custom",
      });
    });
  });
});
