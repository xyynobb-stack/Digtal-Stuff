import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Discover from "./Discover";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "discover.title": "Discover",
        "discover.subtitle": "Browse",
        "discover.tabs.skills": "Skills",
        "discover.tabs.agents": "Agents",
        "discover.searchPlaceholder": "Search",
        "discover.refresh": "Refresh",
      })[key] ?? key,
  }),
}));

describe("Discover writing templates entry", () => {
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
        listBundledSkills: vi.fn(async () => []),
        listInstalledRegistry: vi.fn(async () => ({
          skills: [],
          mcps: [],
          workflows: [],
        })),
        listProfiles: vi.fn(async () => []),
        listInstalledSkills: vi.fn(async () => []),
        listUserAddedSkills: vi.fn(async () => []),
        listWritingTemplates: vi.fn(async () => []),
        importWritingTemplate: vi.fn(async () => ({
          success: false,
          canceled: true,
        })),
      },
    });
  });

  it("removes MCPs and Workflows and opens the writing-template empty view", async () => {
    // @lat: [[discover#Writing templates entry]]
    render(<Discover visible />);

    await waitFor(() =>
      expect(window.hermesAPI.fetchRegistry).toHaveBeenCalled(),
    );
    expect(screen.queryByRole("button", { name: /MCPs/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Workflows/i })).toBeNull();

    const templateTab = screen
      .getAllByRole("button", { name: /写作模板/ })
      .find((button) => button.classList.contains("discover-tab"));
    expect(templateTab).toBeDefined();
    fireEvent.click(templateTab!);

    expect(screen.getByText("暂无写作模板")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("搜索写作模板...")).toBeInTheDocument();
  });

  it("imports and displays an original writing-template file", async () => {
    const template = {
      id: "report-123",
      name: "工作报告",
      fileName: "工作报告.docx",
      extension: "docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      size: 128,
      createdAt: "2026-08-07T00:00:00.000Z",
      path: "C:\\templates\\工作报告.docx",
    };
    vi.mocked(window.hermesAPI.importWritingTemplate).mockResolvedValueOnce({
      success: true,
      template,
    });
    vi.mocked(window.hermesAPI.listWritingTemplates)
      .mockResolvedValueOnce([])
      .mockResolvedValue([template]);
    render(<Discover visible />);
    await waitFor(() =>
      expect(window.hermesAPI.listWritingTemplates).toHaveBeenCalled(),
    );

    fireEvent.click(screen.getByRole("button", { name: /添加写作模板/ }));

    await waitFor(() =>
      expect(screen.getByText("工作报告")).toBeInTheDocument(),
    );
    expect(screen.getByText("工作报告.docx")).toBeInTheDocument();
  });

  it("separates collapsible system skills from always-visible user skills", async () => {
    // @lat: [[discover#Skill ownership columns]]
    vi.mocked(window.hermesAPI.fetchRegistry).mockResolvedValue({
      skills: [
        {
          id: "community-only",
          name: "community-only",
          description: "Available from the registry but not bundled",
        },
      ],
      mcps: [],
      agents: [],
      workflows: [],
    });
    vi.mocked(window.hermesAPI.listBundledSkills).mockResolvedValue([
      {
        name: "system-research",
        description: "Built into the system",
        category: "research",
        source: "bundled",
        installed: true,
      },
    ]);
    vi.mocked(window.hermesAPI.listUserAddedSkills).mockResolvedValue([
      {
        name: "hr",
        description: "Human resources partner",
        category: "custom",
        path: "C:\\skills\\custom\\hr",
      },
    ]);

    render(<Discover visible />);

    await waitFor(() => {
      expect(screen.getByText("system-research")).toBeInTheDocument();
      expect(screen.getByText("hr")).toBeInTheDocument();
    });
    expect(screen.queryByText("community-only")).not.toBeInTheDocument();

    const systemToggle = screen.getByRole("button", {
      name: /系统自带 SKILL/,
    });
    expect(systemToggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(systemToggle);
    expect(systemToggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("system-research")).not.toBeVisible();
    expect(screen.getByText("hr")).toBeInTheDocument();

    fireEvent.click(systemToggle);
    expect(screen.getByText("system-research")).toBeVisible();
  });
});
