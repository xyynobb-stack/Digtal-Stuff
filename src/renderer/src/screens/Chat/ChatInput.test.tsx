import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ChatInput pulls translations through useI18n (which requires the i18next
// provider). Stub it so the component can render in isolation; the keys are
// irrelevant to keyboard behavior.
vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import { ChatInput } from "./ChatInput";

afterEach(cleanup);

function renderInput(
  slashCommands?: React.ComponentProps<typeof ChatInput>["slashCommands"],
): {
  onSubmit: ReturnType<typeof vi.fn>;
  textarea: HTMLTextAreaElement;
  container: HTMLElement;
} {
  const onSubmit = vi.fn();
  const { container } = render(
    <ChatInput
      isLoading={false}
      hasSession={true}
      stagingScopeId="test-run"
      onSubmit={onSubmit}
      onQuickAsk={vi.fn()}
      onAbort={vi.fn()}
      slashCommands={slashCommands}
    />,
  );
  const textarea = screen.getByPlaceholderText(
    "chat.typeMessage",
  ) as HTMLTextAreaElement;
  return { onSubmit, textarea, container };
}

describe("ChatInput — CJK IME Enter handling", () => {
  // Repro: typing Korean (or any CJK IME), the final syllable stays in
  // composition. macOS Chromium can deliver the finalizing Enter as a plain
  // keydown (isComposing=false, keyCode=13) before compositionend commits the
  // last syllable, so submitting on that keydown sends a truncated message.
  it("does not submit while an IME composition is still active", () => {
    const { onSubmit, textarea } = renderInput();

    fireEvent.compositionStart(textarea);
    // State only holds what was committed so far — last syllable not yet in.
    fireEvent.change(textarea, { target: { value: "안녕하세" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Must not fire — otherwise the truncated "안녕하세" goes out.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("submits the full text after composition ends", () => {
    const { onSubmit, textarea } = renderInput();

    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: "안녕하세" } });
    fireEvent.keyDown(textarea, { key: "Enter" }); // swallowed: still composing

    // compositionend commits the last syllable; React flushes the full value.
    fireEvent.compositionEnd(textarea, { target: { value: "안녕하세요" } });
    fireEvent.change(textarea, { target: { value: "안녕하세요" } });
    fireEvent.keyDown(textarea, { key: "Enter" }); // now a real submit

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("안녕하세요", []);
  });
});

describe("ChatInput — native content sizing", () => {
  it("does not synchronously read scrollHeight while typing", () => {
    const { textarea } = renderInput();
    const scrollHeightRead = vi.fn(() => 80);
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: scrollHeightRead,
    });

    fireEvent.change(textarea, { target: { value: "一段新的输入" } });

    expect(textarea.value).toBe("一段新的输入");
    expect(scrollHeightRead).not.toHaveBeenCalled();
    expect(textarea.style.height).toBe("");
  });
});

describe("ChatInput — attachment ingestion barrier", () => {
  it("does not submit until the selected file has reached app-owned staging", async () => {
    let finishCopy: (path: string) => void = () => {};
    const copyPromise = new Promise<string>((resolve) => {
      finishCopy = resolve;
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getPathForFile: vi.fn(() => "C:/Users/me/report.docx"),
        stageAttachmentFromPath: vi.fn(() => copyPromise),
        stageAttachment: vi.fn(),
        recordColdStartTiming: vi.fn(),
      },
    });

    const { onSubmit, textarea, container } = renderInput();
    const picker = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["document"], "report.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    fireEvent.change(picker, { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "请总结附件" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("chat.attachmentPreparing")).toBeVisible();

    finishCopy("C:/staging/test-run/report.docx");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0]).toBe("请总结附件");
    expect(onSubmit.mock.calls[0][1]).toEqual([
      expect.objectContaining({
        kind: "path-ref",
        path: "C:/staging/test-run/report.docx",
      }),
    ]);
  });

  it("does not silently send text when staging the selected file fails", async () => {
    let failCopy: (error: Error) => void = () => {};
    const copyPromise = new Promise<string>((_resolve, reject) => {
      failCopy = reject;
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getPathForFile: vi.fn(() => "C:/Users/me/moved.docx"),
        stageAttachmentFromPath: vi.fn(() => copyPromise),
        stageAttachment: vi.fn(),
        recordColdStartTiming: vi.fn(),
      },
    });

    const { onSubmit, textarea, container } = renderInput();
    const picker = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["document"], "moved.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    fireEvent.change(picker, { target: { files: [file] } });
    fireEvent.change(textarea, { target: { value: "请总结附件" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    failCopy(new Error("source disappeared"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "chat.attachReadFailed",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea.value).toBe("请总结附件");
  });
});

describe("ChatInput — slash command palette", () => {
  it("opens on slash and filters commands while typing", () => {
    const { textarea } = renderInput();

    fireEvent.change(textarea, { target: { value: "/" } });
    expect(
      screen.getByRole("dialog", { name: "chat.commandsTitle" }),
    ).toBeTruthy();
    expect(screen.getByText("agents")).toBeTruthy();

    fireEvent.change(textarea, { target: { value: "/lea" } });
    expect(screen.getByText("learn")).toBeTruthy();
    expect(screen.queryByText("agents")).toBeNull();
  });

  it("closes with Escape from anywhere in the modal while keeping the draft", () => {
    const { textarea } = renderInput();

    fireEvent.change(textarea, { target: { value: "/lea" } });
    const option = screen.getByRole("option", { name: /learn/i });
    option.focus();
    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(textarea.value).toBe("/lea");
    expect(document.activeElement).toBe(textarea);
  });

  it("virtualizes large command catalogs", () => {
    const commands = Array.from({ length: 1_000 }, (_, index) => ({
      name: `/command-${index}`,
      description: `Command ${index}`,
      category: "agent" as const,
    }));
    const { textarea } = renderInput(commands);

    fireEvent.change(textarea, { target: { value: "/" } });

    expect(screen.getByText("1000 commands")).toBeTruthy();
    expect(screen.getAllByRole("option").length).toBeLessThan(30);
    expect(screen.getByText("command-0")).toBeTruthy();
    expect(screen.queryByText("command-999")).toBeNull();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(screen.getByText("command-999")).toBeTruthy();
    expect(screen.queryByText("command-0")).toBeNull();
  });
});
