import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatEmptyState } from "./ChatEmptyState";

vi.mock("../../components/common/HermesLogo", () => ({
  default: () => <div data-testid="hermes-logo" />,
}));

const labels: Record<string, string> = {
  "chat.emptyTitle": "今天我可以帮你做什么？",
  "chat.emptyHint": "请选择快捷任务",
  "chat.suggestionSearch": "帮我写周报",
  "chat.suggestionReminder": "汇总多份报表",
  "chat.suggestionEmail": "提取文件信息",
  "chat.suggestionScript": "查资料做对比",
  "chat.suggestionSchedule": "设置定时提醒",
  "chat.suggestionAnalyze": "整理会议纪要",
};

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => labels[key] ?? key,
  }),
}));

describe("ChatEmptyState", () => {
  // @lat: [[chat-quick-actions#Chinese workplace quick actions]]
  it("fills the composer with each Chinese workplace prompt", () => {
    const onSelectSuggestion = vi.fn();
    render(<ChatEmptyState onSelectSuggestion={onSelectSuggestion} />);

    const expectedPrompts = [
      ["帮我写周报", "请根据我提供的本周工作材料"],
      ["汇总多份报表", "请汇总并分析我上传的多份报表"],
      ["提取文件信息", "请读取我上传的文件"],
      ["查资料做对比", "查找并对比【对象A】和【对象B】"],
      ["设置定时提醒", "请在【提醒日期和时间】提醒我"],
      ["整理会议纪要", "会议记录、转写文本或会议材料"],
    ] as const;

    for (const [label, promptFragment] of expectedPrompts) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onSelectSuggestion).toHaveBeenLastCalledWith(
        expect.stringContaining(promptFragment),
      );
    }

    expect(onSelectSuggestion).toHaveBeenCalledTimes(expectedPrompts.length);
    expect(onSelectSuggestion).not.toHaveBeenCalledWith(
      expect.stringContaining("会议录音"),
    );
  });
});
