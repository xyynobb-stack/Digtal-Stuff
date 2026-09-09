import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyExperience } from "../../../../shared/experience-skill";
import FeatureHub from "./FeatureHub";

describe("experience feature navigation and publication", () => {
  beforeEach(() => {
    vi.stubGlobal("hermesAPI", {
      loadExperience: vi.fn().mockImplementation(async (profile: string) => ({
        displayName: profile === "employee-b" ? "陈杰" : "向永驿",
        template: emptyExperience(),
        revision: "",
      })),
      previewExperience: vi.fn().mockResolvedValue({
        token: "preview-token",
        markdown: "# 流程预览",
        displayName: "向永驿的SKILL",
        replacing: false,
      }),
      publishExperience: vi.fn().mockResolvedValue({ revision: "next" }),
    });
  });
  it("returns to catalog, retains draft, and isolates a different profile", async () => {
    const view = render(<FeatureHub profile="employee-a" />);
    fireEvent.click(screen.getByRole("button", { name: /岗位经验沉淀/ }));
    await screen.findByText("向永驿的SKILL");
    fireEvent.change(screen.getByLabelText("岗位"), {
      target: { value: "项目经理" },
    });
    fireEvent.click(screen.getByRole("button", { name: "返回功能区" }));
    expect(screen.getByRole("heading", { name: "功能区" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /岗位经验沉淀/ }));
    expect(await screen.findByDisplayValue("项目经理")).toBeInTheDocument();
    view.rerender(<FeatureHub profile="employee-b" />);
    await screen.findByText("陈杰的SKILL");
    expect(screen.getByLabelText("岗位")).toHaveValue("");
  });
  it("requires preview confirmation and refreshes selectable skills after save", async () => {
    const listener = vi.fn();
    window.addEventListener("hermes-skills-changed", listener);
    render(<FeatureHub profile="employee-c" />);
    fireEvent.click(screen.getByRole("button", { name: /岗位经验沉淀/ }));
    await screen.findByText("向永驿的SKILL");
    const previewButton = screen.getByRole("button", {
      name: "生成 SKILL 预览",
    });
    expect(previewButton).toHaveClass("experience-primary-action");
    fireEvent.click(previewButton);
    await screen.findByText("# 流程预览");
    expect(window.hermesAPI.publishExperience).not.toHaveBeenCalled();
    const publishButton = screen.getByRole("button", {
      name: "确认保存为可选 SKILL",
    });
    expect(publishButton).toHaveClass("experience-publish-action");
    fireEvent.click(publishButton);
    await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(window.hermesAPI.publishExperience).toHaveBeenCalledWith(
      "employee-c",
      "preview-token",
    );
    window.removeEventListener("hermes-skills-changed", listener);
  });

  it("deletes the first scene without a native modal and immediately focuses the survivor", async () => {
    render(<FeatureHub profile="employee-delete-test" />);
    fireEvent.click(screen.getByRole("button", { name: /岗位经验沉淀/ }));
    await screen.findByText("向永驿的SKILL");

    fireEvent.click(screen.getByRole("button", { name: "添加场景" }));
    let titles = screen.getAllByLabelText("场景名称");
    fireEvent.change(titles[0], { target: { value: "准备阶段" } });
    fireEvent.change(titles[1], { target: { value: "验收阶段" } });

    fireEvent.click(screen.getAllByRole("button", { name: "删除此场景" })[0]);
    expect(
      screen.getByRole("group", { name: "确认删除场景 1" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    titles = screen.getAllByLabelText("场景名称");
    expect(titles).toHaveLength(1);
    expect(titles[0]).toHaveValue("验收阶段");
    await waitFor(() => expect(titles[0]).toHaveFocus());
    fireEvent.change(titles[0], { target: { value: "验收与复盘" } });
    expect(titles[0]).toHaveValue("验收与复盘");
  });
});
