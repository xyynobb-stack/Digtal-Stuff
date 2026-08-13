import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Schedules from "./Schedules";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => key,
  }),
}));

vi.mock("../../components/OrbLoader", () => ({
  OrbLoader: () => <div>loading</div>,
}));

const template = {
  id: "weekly-xlsx",
  name: "周报模板",
  description: "标准周报表格",
  fileName: "周报模板.xlsx",
  extension: "xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 256,
  createdAt: "2026-08-13T00:00:00.000Z",
  path: "C:\\templates\\周报模板.xlsx",
};

describe("Schedules recommendations", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getHermesHome: vi.fn(async () => "C:\\hermes"),
        listCronJobs: vi.fn(async () => []),
        listModels: vi.fn(async () => [
          {
            id: "model-1",
            name: "Default model",
            provider: "openai",
            model: "gpt-test",
            baseUrl: "https://example.test",
          },
        ]),
        getModelConfig: vi.fn(async () => ({
          provider: "openai",
          model: "gpt-test",
          baseUrl: "https://example.test",
        })),
        listWritingTemplates: vi.fn(async () => [template]),
        createCronJob: vi.fn(async () => ({ success: true })),
        selectFolder: vi.fn(async () => null),
      },
    });
  });

  it("creates a weekly recommendation with template data and validates its range", async () => {
    render(<Schedules profile="writer" />);

    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "计划推荐" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /周报汇总/ }));

    fireEvent.change(screen.getByPlaceholderText("请输入姓名"), {
      target: { value: "张三" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("请输入需要汇总的工作事项、进展、成果和问题"),
      { target: { value: "完成项目验收并整理客户反馈。" } },
    );

    fireEvent.change(screen.getByLabelText("本周起始日期年份"), {
      target: { value: "2026" },
    });
    fireEvent.change(screen.getByLabelText("本周起始日期月份"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("本周起始日期日期"), {
      target: { value: "20" },
    });
    fireEvent.change(screen.getByLabelText("本周结束日期年份"), {
      target: { value: "2026" },
    });
    fireEvent.change(screen.getByLabelText("本周结束日期月份"), {
      target: { value: "8" },
    });
    fireEvent.change(screen.getByLabelText("本周结束日期日期"), {
      target: { value: "19" },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "本周结束日期不能早于本周起始日期",
    );
    expect(
      screen.getByRole("button", { name: "schedules.create" }),
    ).toBeDisabled();

    fireEvent.change(screen.getByLabelText("本周结束日期日期"), {
      target: { value: "21" },
    });
    fireEvent.click(screen.getByRole("button", { name: "schedules.create" }));

    await waitFor(() =>
      expect(window.hermesAPI.createCronJob).toHaveBeenCalled(),
    );
    const call = vi.mocked(window.hermesAPI.createCronJob).mock.calls[0];
    expect(call[0]).toBe("00 09 * * 1");
    expect(call[1]).toContain("周报汇总");
    expect(call[1]).toContain("2026-08-20 至 2026-08-21");
    expect(call[1]).toContain("C:\\templates\\周报模板.xlsx");
    expect(call[1]).toContain("完成项目验收并整理客户反馈");
    expect(call[2]).toBe("周报汇总");
    expect(call[4]).toBe("writer");
    expect(call[5]).toBe("gpt-test");
    expect(call[6]).toBe("openai");
  });
});
