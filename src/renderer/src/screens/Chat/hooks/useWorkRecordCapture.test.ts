import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types";
import type { WorkRecordStep } from "../../../../../shared/work-records";
import {
  buildWorkRecordSnapshot,
  deriveWorkRecordTitle,
  parseWorkRecordEnrichment,
  useWorkRecordCapture,
} from "./useWorkRecordCapture";

const context = {
  profileId: "default",
  profileName: "向永泽",
  sessionId: "session-1",
  skills: [] as string[],
  template: false,
  contextFolder: false,
  createdAt: 100,
};

describe("work record capture", () => {
  // @lat: [[work-records#Meaningful work filter]]
  it("does not record ordinary greetings", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "你好", turnId: "turn-1" },
    ];
    expect(
      buildWorkRecordSnapshot("turn-1", messages, context, 1, false),
    ).toBeNull();
  });

  // @lat: [[work-records#Progressive titles]]
  it("uses stable Chinese titles for common work tasks", () => {
    expect(
      deriveWorkRecordTitle("请根据材料帮我整理一份工作周报", []).title,
    ).toBe("帮我写周报");
    expect(deriveWorkRecordTitle("请查资料并对比三家供应商", []).title).toBe(
      "查资料做对比",
    );
    expect(
      deriveWorkRecordTitle("这份周报中的本周工作有哪些", []).title,
    ).not.toBe("帮我写周报");
  });

  it("parses one-shot titles and business steps without surrounding text", () => {
    expect(
      parseWorkRecordEnrichment(
        '结果如下：\n{"title":"提取周报中的本周工作","steps":["读取周报文件","提取本周工作","整理并返回结果"]}',
      ),
    ).toEqual({
      title: "提取周报中的本周工作",
      steps: ["读取周报文件", "提取本周工作", "整理并返回结果"],
    });
    expect(parseWorkRecordEnrichment("不是 JSON")).toBeNull();
  });

  // @lat: [[work-records#Turn snapshots]]
  it("records one turn and progresses from running to completed", () => {
    const user: ChatMessage = {
      id: "u",
      role: "user",
      content: "请提取文件信息",
      turnId: "turn-2",
      attachments: [
        {
          id: "a",
          kind: "path-ref",
          name: "合同.docx",
          mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          size: 10,
          path: "C:\\staged\\合同.docx",
        },
      ],
    };
    const running = buildWorkRecordSnapshot("turn-2", [user], context, 1, true);
    expect(running?.status).toBe("running");
    const completed = buildWorkRecordSnapshot(
      "turn-2",
      [
        user,
        {
          id: "a",
          role: "agent",
          content: "合同主体为甲乙双方。",
          turnId: "turn-2",
          pending: false,
        },
      ],
      context,
      2,
      false,
    );
    expect(completed?.status).toBe("completed");
    expect(completed?.attachments[0].path).toContain("staged");
    expect(completed?.resultSummary).toContain("甲乙双方");
  });

  // @lat: [[work-records#Business steps]]
  it("keeps raw tool output out of the user-facing fallback steps", () => {
    const messages: ChatMessage[] = [
      {
        id: "u",
        role: "user",
        content: "分析文件内容",
        turnId: "turn-3",
      },
      {
        id: "call",
        kind: "tool_call",
        role: "agent",
        callId: "call-1",
        name: "execute_code",
        args: '{"code":"secret"}',
        status: "completed",
      },
      {
        id: "result",
        kind: "tool_result",
        role: "agent",
        callId: "call-1",
        name: "execute_code",
        content: "Traceback with an internal path",
      },
      {
        id: "answer",
        role: "agent",
        content: "分析完成。",
        turnId: "turn-3",
      },
    ];
    const snapshot = buildWorkRecordSnapshot(
      "turn-3",
      messages,
      context,
      1,
      false,
    );
    expect(snapshot?.steps.map((step) => step.label)).toContain(
      "处理并分析内容",
    );
    expect(snapshot?.steps.some((step) => step.preview)).toBe(false);
    expect(JSON.stringify(snapshot?.steps)).not.toContain("execute_code");
    expect(JSON.stringify(snapshot?.steps)).not.toContain("Traceback");
  });

  it("replaces the local snapshot with one-shot metadata asynchronously", async () => {
    const recordWorkRecordSnapshot = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { recordWorkRecordSnapshot },
    });
    const enrichWorkRecord = vi.fn().mockResolvedValue(
      JSON.stringify({
        title: "提取周报中的本周工作",
        steps: ["读取周报文件", "提取本周工作", "整理并返回结果"],
      }),
    );
    const user: ChatMessage = {
      id: "u",
      role: "user",
      content: "这份周报中的本周工作有哪些",
      turnId: "turn-4",
      attachments: [
        {
          id: "weekly-report",
          kind: "path-ref",
          name: "个人周报.xlsx",
          mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          size: 10,
          path: "C:\\staged\\个人周报.xlsx",
        },
      ],
    };
    const messages: ChatMessage[] = [
      user,
      {
        id: "answer",
        role: "agent",
        content: "本周完成了需求分析。",
        turnId: "turn-4",
      },
    ];
    const runningMessages: ChatMessage[] = [user];

    const view = renderHook(
      ({ turnMessages, isLoading }) =>
        useWorkRecordCapture({
          messages: turnMessages,
          profileId: "default",
          profileName: "向永泽",
          sessionId: "session-1",
          skills: [],
          template: false,
          contextFolder: null,
          isLoading,
          enrichWorkRecord,
        }),
      { initialProps: { turnMessages: runningMessages, isLoading: true } },
    );
    view.rerender({ turnMessages: messages, isLoading: false });

    await waitFor(() => expect(enrichWorkRecord).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const snapshots = recordWorkRecordSnapshot.mock.calls.map(
        ([snapshot]) => snapshot as { title: string; steps: WorkRecordStep[] },
      );
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.title === "提取周报中的本周工作" &&
            snapshot.steps[0]?.label === "读取周报文件",
        ),
      ).toBe(true);
    });
  });

  it("does not regenerate metadata when an old completed conversation is restored", async () => {
    const recordWorkRecordSnapshot = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: { recordWorkRecordSnapshot },
    });
    const enrichWorkRecord = vi.fn().mockResolvedValue(null);
    const messages: ChatMessage[] = [
      {
        id: "u",
        role: "user",
        content: "请分析历史报表",
        turnId: "old-turn",
      },
      {
        id: "answer",
        role: "agent",
        content: "历史分析结果。",
        turnId: "old-turn",
      },
    ];

    renderHook(() =>
      useWorkRecordCapture({
        messages,
        profileId: "default",
        profileName: "向永泽",
        sessionId: "session-old",
        skills: [],
        template: false,
        contextFolder: null,
        isLoading: false,
        enrichWorkRecord,
      }),
    );

    await waitFor(() =>
      expect(recordWorkRecordSnapshot).toHaveBeenCalledTimes(1),
    );
    expect(enrichWorkRecord).not.toHaveBeenCalled();
  });
});
