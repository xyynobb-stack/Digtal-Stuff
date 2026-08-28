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
});
