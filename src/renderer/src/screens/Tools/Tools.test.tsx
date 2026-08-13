import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Tools from "./Tools";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "tools.title": "Tools",
        "tools.mcpServers": "MCP Servers",
        "navigation.skills": "Skills",
        "tools.writingTemplates": "Writing templates",
        "tools.writingTemplateSearch": "Search writing templates...",
        "tools.writingTemplateEmptyTitle": "No writing templates yet",
        "tools.writingTemplateEmptyDescription":
          "Writing templates you add later will appear here.",
      })[key] ?? key,
  }),
}));

describe("Capabilities writing templates entry", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        fetchRegistry: vi.fn(async () => ({
          skills: [],
          mcps: [],
          agents: [],
          workflows: [],
        })),
        getToolsets: vi.fn(async () => []),
        listMcpServers: vi.fn(async () => []),
        listWritingTemplates: vi.fn(async () => []),
        updateWritingTemplateDescription: vi.fn(async () => null),
      },
    });
  });

  it("shows the saved template description instead of the source filename", async () => {
    vi.mocked(window.hermesAPI.listWritingTemplates).mockResolvedValue([
      {
        id: "contract-123",
        name: "Server rental contract",
        description: "Standard contract for server equipment rental",
        fileName: "server-contract.docx",
        extension: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 128,
        createdAt: "2026-08-12T00:00:00.000Z",
        path: "C:\\templates\\server-contract.docx",
      },
    ]);
    render(<Tools visible />);

    await waitFor(() =>
      expect(window.hermesAPI.getToolsets).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Writing templates/ }));

    expect(
      await screen.findByText("Standard contract for server equipment rental"),
    ).toBeInTheDocument();
    expect(screen.queryByText("server-contract.docx")).not.toBeInTheDocument();
  });

  it("replaces the MCP Servers tab with a writing templates view", async () => {
    // @lat: [[discover#Capabilities writing templates entry]]
    render(<Tools visible />);

    await waitFor(() =>
      expect(window.hermesAPI.getToolsets).toHaveBeenCalled(),
    );
    expect(
      screen.queryByRole("button", { name: /MCP Servers/ }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Writing templates/ }));
    expect(screen.getByTestId("writing-templates-pane")).toBeInTheDocument();
    expect(screen.getByText("No writing templates yet")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search writing templates..."),
    ).toBeInTheDocument();
  });
});
