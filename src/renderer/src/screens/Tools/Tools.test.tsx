import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Tools from "./Tools";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "tools.title": "工具",
        "tools.mcpServers": "MCP 服务器",
        "navigation.skills": "技能",
        "tools.writingTemplates": "写作模板",
        "tools.writingTemplateSearch": "搜索写作模板...",
        "tools.writingTemplateEmptyTitle": "暂无写作模板",
        "tools.writingTemplateEmptyDescription":
          "后续添加的写作模板会显示在这里。",
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
      },
    });
  });

  it("replaces the MCP Servers tab with a writing templates view", async () => {
    // @lat: [[discover#Capabilities writing templates entry]]
    render(<Tools visible />);

    await waitFor(() =>
      expect(window.hermesAPI.getToolsets).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("button", { name: /MCP 服务器/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /写作模板/ }));

    expect(screen.getByTestId("writing-templates-pane")).toBeInTheDocument();
    expect(screen.getByText("暂无写作模板")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索写作模板...")).toBeInTheDocument();
  });
});
