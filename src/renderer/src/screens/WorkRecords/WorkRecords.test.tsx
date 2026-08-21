import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkRecordDetail,
  WorkRecordSummary,
} from "../../../../shared/work-records";
import WorkRecords from "./WorkRecords";

const summary: WorkRecordSummary = {
  id: "turn-1",
  profileId: "default",
  sessionId: "session-1",
  title: "旧记录名称",
  type: "document",
  status: "completed",
  createdAt: 100,
  updatedAt: 200,
  completedAt: 200,
};

const detail: WorkRecordDetail = {
  ...summary,
  profileName: "向永泽",
  prompt: "提取周报内容",
  resultSummary: "处理完成",
  attachments: [],
  steps: [
    {
      id: "step-1",
      name: "business-step",
      label: "读取周报文件",
      status: "completed",
      position: 0,
    },
  ],
};

function installApi(): {
  renameWorkRecord: ReturnType<typeof vi.fn>;
  deleteWorkRecord: ReturnType<typeof vi.fn>;
} {
  const renameWorkRecord = vi.fn().mockResolvedValue(true);
  const deleteWorkRecord = vi.fn().mockResolvedValue(true);
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listWorkRecords: vi.fn().mockResolvedValue([summary]),
      getWorkRecord: vi.fn().mockResolvedValue(detail),
      renameWorkRecord,
      deleteWorkRecord,
      exportWorkRecords: vi.fn().mockResolvedValue(null),
      exportWorkRecord: vi.fn().mockResolvedValue(null),
      openWorkRecordAttachment: vi.fn().mockResolvedValue(true),
      onWorkRecordsChanged: vi.fn().mockReturnValue(() => {}),
    },
  });
  return { renameWorkRecord, deleteWorkRecord };
}

describe("WorkRecords", () => {
  it("renames a record inline without using the unsupported browser prompt", async () => {
    const { renameWorkRecord } = installApi();
    render(
      <WorkRecords
        profile="default"
        profileName="向永泽"
        visible
        onOpenSession={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTitle("重命名"));
    const input = screen.getByRole("textbox", { name: "记录名称" });
    fireEvent.change(input, { target: { value: "提取周报中的本周工作" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(renameWorkRecord).toHaveBeenCalledWith(
        "turn-1",
        "提取周报中的本周工作",
      ),
    );
    expect(screen.queryByRole("textbox", { name: "记录名称" })).toBeNull();
  });

  it("deletes only after an in-app confirmation", async () => {
    const { deleteWorkRecord } = installApi();
    render(
      <WorkRecords
        profile="default"
        profileName="向永泽"
        visible
        onOpenSession={() => {}}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "删除记录" }));
    expect(deleteWorkRecord).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "原对话和源文件不会被删除",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(deleteWorkRecord).toHaveBeenCalledWith("turn-1"),
    );
    await waitFor(() =>
      expect(screen.queryByText("旧记录名称")).not.toBeInTheDocument(),
    );
  });
});
