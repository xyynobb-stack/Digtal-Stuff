import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionSkillPicker } from "./SessionSkillPicker";

describe("SessionSkillPicker display names", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listUserAddedSkills: vi.fn(async () => [
          {
            name: "market-report-rag",
            displayName: "市场分析报告",
            category: "custom",
            description: "生成市场分析报告",
            path: "C:\\skills\\custom\\market-report-rag",
            userAdded: true,
          },
          {
            name: "downloaded-skill",
            category: "custom",
            description: "Third-party Skill",
            path: "C:\\skills\\custom\\downloaded-skill",
            userAdded: true,
          },
          {
            name: "project-manager",
            displayName: "项目管理",
            category: "custom",
            description: "项目经理岗位能力",
            path: "C:\\skills\\custom\\project-manager",
            userAdded: true,
          },
        ]),
      },
    });
  });

  it("shows optional labels but toggles stable English names", async () => {
    // @lat: [[discover#User Skill display names]]
    const onChange = vi.fn();
    render(<SessionSkillPicker activeSkills={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /技能/ }));
    await waitFor(() => {
      expect(screen.getByText("市场分析报告")).toBeInTheDocument();
      expect(screen.getByText("downloaded-skill")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("市场分析报告"));
    expect(onChange).toHaveBeenCalledWith(["market-report-rag"]);
  });

  it("does not allow a mandatory role Skill to be removed", async () => {
    const onChange = vi.fn();
    render(
      <SessionSkillPicker
        activeSkills={["project-manager"]}
        lockedSkills={["project-manager"]}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /技能/ }));
    const roleSkill = await screen.findByRole("button", {
      name: /项目管理.*岗位必需/,
    });
    expect(roleSkill).toBeDisabled();
    fireEvent.click(roleSkill);
    expect(onChange).not.toHaveBeenCalled();
  });
});
