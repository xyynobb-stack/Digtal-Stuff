import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Schedules, {
  buildCustomSchedule,
  parseFeishuFolderToken,
} from "./Schedules";

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
        isRemoteMode: vi.fn(async () => false),
        listWritingTemplates: vi.fn(async () => [template]),
        importWritingTemplate: vi.fn(async () => ({
          success: true,
          template,
        })),
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

  it("creates an ordinary task with an optional template and required workbook skill", async () => {
    render(<Schedules profile="writer" />);

    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    const selector = await screen.findByLabelText("写作模板（可选）");
    expect(selector).toHaveValue("");
    fireEvent.change(selector, { target: { value: template.id } });
    fireEvent.change(
      screen.getByPlaceholderText("schedules.promptPlaceholder"),
      { target: { value: "整理本月项目进展。" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "schedules.create" }));

    await waitFor(() =>
      expect(window.hermesAPI.createCronJob).toHaveBeenCalled(),
    );
    const call = vi.mocked(window.hermesAPI.createCronJob).mock.calls[0];
    expect(call[1]).toContain("整理本月项目进展。");
    expect(call[1]).toContain("C:\\templates\\周报模板.xlsx");
    expect(call[8]).toEqual(["xlsx"]);
  });

  it("stores Feishu delivery as a Drive folder target while keeping the UI label", async () => {
    render(<Schedules profile="writer" />);

    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    fireEvent.change(screen.getByPlaceholderText("schedules.promptPlaceholder"), {
      target: { value: "生成月报文件。" },
    });
    const deliverySelect = screen
      .getByRole("option", { name: "飞书" })
      .closest("select");
    expect(deliverySelect).not.toBeNull();
    fireEvent.change(deliverySelect as HTMLSelectElement, {
      target: { value: "feishu" },
    });
    fireEvent.change(screen.getByLabelText("飞书云盘目标文件夹"), {
      target: {
        value: "https://example.feishu.cn/drive/folder/folder_token_123",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "schedules.create" }));

    await waitFor(() =>
      expect(window.hermesAPI.createCronJob).toHaveBeenCalled(),
    );
    expect(vi.mocked(window.hermesAPI.createCronJob).mock.calls[0][3]).toBe(
      "feishu:folder_token_123",
    );
  });

  it("validates Feishu folder links and tokens", () => {
    expect(parseFeishuFolderToken("")).toBe("");
    expect(parseFeishuFolderToken("folder_token_123")).toBe(
      "folder_token_123",
    );
    expect(
      parseFeishuFolderToken(
        "https://example.feishu.cn/drive/home/folder/folder_token_123",
      ),
    ).toBe("folder_token_123");
    expect(parseFeishuFolderToken("https://evil.test/drive/folder/token")).toBe(
      null,
    );
  });

  it("imports a template from the create form and selects it immediately", async () => {
    const imported = {
      ...template,
      id: "new-docx",
      name: "新合同模板",
      fileName: "新合同模板.docx",
      extension: "docx",
      path: "C:\\templates\\新合同模板.docx",
    };
    vi.mocked(window.hermesAPI.listWritingTemplates)
      .mockResolvedValueOnce([])
      .mockResolvedValue([imported]);
    vi.mocked(window.hermesAPI.importWritingTemplate).mockResolvedValueOnce({
      success: true,
      template: imported,
    });

    render(<Schedules profile="writer" />);
    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    fireEvent.click(screen.getByRole("button", { name: "添加写作模板" }));

    await waitFor(() =>
      expect(window.hermesAPI.importWritingTemplate).toHaveBeenCalledWith(
        "writer",
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("写作模板（可选）")).toHaveValue(
        imported.id,
      ),
    );
  });

  it("disables local template actions in remote mode", async () => {
    vi.mocked(window.hermesAPI.isRemoteMode).mockResolvedValueOnce(true);

    render(<Schedules profile="remote-profile" />);
    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));

    expect(await screen.findByLabelText("写作模板（可选）")).toBeDisabled();
    expect(screen.getByRole("button", { name: "添加写作模板" })).toBeDisabled();
    expect(
      screen.getByText("写作模板目前仅支持本地计划任务。"),
    ).toBeInTheDocument();
  });

  it("builds a custom annual schedule from plain date and time fields", async () => {
    render(<Schedules profile="writer" />);
    await screen.findByText("schedules.empty");
    fireEvent.click(screen.getByRole("button", { name: "schedules.newTask" }));
    fireEvent.click(
      screen.getByRole("button", { name: "schedules.frequencyCustom" }),
    );

    fireEvent.change(screen.getByLabelText("schedules.customMonth"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("schedules.customDay"), {
      target: { value: "31" },
    });
    fireEvent.change(screen.getByLabelText("schedules.customHour"), {
      target: { value: "23" },
    });
    fireEvent.change(screen.getByLabelText("schedules.customMinute"), {
      target: { value: "45" },
    });
    fireEvent.change(
      screen.getByPlaceholderText("schedules.promptPlaceholder"),
      { target: { value: "生成年度总结。" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "schedules.create" }));

    await waitFor(() =>
      expect(window.hermesAPI.createCronJob).toHaveBeenCalled(),
    );
    expect(vi.mocked(window.hermesAPI.createCronJob).mock.calls[0][0]).toBe(
      "45 23 31 12 *",
    );
  });

  it("rejects impossible custom dates but allows February 29", () => {
    expect(buildCustomSchedule("2", "30", "9", "0")).toBeNull();
    expect(buildCustomSchedule("2", "29", "9", "0")).toBe("0 9 29 2 *");
    expect(buildCustomSchedule("13", "1", "9", "0")).toBeNull();
    expect(buildCustomSchedule("1", "1", "24", "0")).toBeNull();
  });
});
