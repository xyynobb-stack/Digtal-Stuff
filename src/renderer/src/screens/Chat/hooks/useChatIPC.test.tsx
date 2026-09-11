import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { settleFinalDbTranscript, useChatIPC } from "./useChatIPC";
import type { ActiveTurn, ChatMessage, UsageState } from "../types";

type Callback<T extends unknown[]> = (...args: T) => void;

interface ChatIpcCallbacks {
  sessionStarted?: Callback<[string, string]>;
  chunk?: Callback<[string, string]>;
  reasoning?: Callback<[string, string]>;
  done?: Callback<[string, string]>;
  error?: Callback<[string, string]>;
  toolProgress?: Callback<[string, string]>;
  toolEvent?: Callback<[string, unknown]>;
  usage?: Callback<[string, UsageState]>;
  contractAnalysis?: Callback<
    [
      {
        profile: string;
        sessionId: string;
        phase: "started" | "completed" | "failed";
        modelOverride: { provider: string; model: string; baseUrl: string };
      },
    ]
  >;
  approval?: Callback<
    [
      string,
      {
        requestId: string;
        description: string;
        command: string;
        choices: Array<"once" | "session" | "always" | "deny">;
      },
    ]
  >;
}

function installHermesApi(callbacks: ChatIpcCallbacks): {
  getSessionMessages: ReturnType<typeof vi.fn>;
} {
  const getSessionMessages = vi.fn(async (sessionId: string) => {
    if (sessionId === "old-session") {
      return [
        { kind: "user", id: 1, content: "old prompt" },
        {
          kind: "assistant",
          id: 2,
          content: "old answer",
          finishReason: "stop",
        },
      ];
    }
    return [];
  });

  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      getSessionMessages,
      onChatSessionStarted: (cb: Callback<[string, string]>) => {
        callbacks.sessionStarted = cb;
        return vi.fn();
      },
      onChatChunk: (cb: Callback<[string, string]>) => {
        callbacks.chunk = cb;
        return vi.fn();
      },
      onChatReasoningChunk: (cb: Callback<[string, string]>) => {
        callbacks.reasoning = cb;
        return vi.fn();
      },
      onChatDone: (cb: Callback<[string, string]>) => {
        callbacks.done = cb;
        return vi.fn();
      },
      onChatError: (cb: Callback<[string, string]>) => {
        callbacks.error = cb;
        return vi.fn();
      },
      onChatToolProgress: (cb: Callback<[string, string]>) => {
        callbacks.toolProgress = cb;
        return vi.fn();
      },
      onChatToolEvent: (cb: Callback<[string, unknown]>) => {
        callbacks.toolEvent = cb;
        return vi.fn();
      },
      onClarifyRequest: vi.fn(() => vi.fn()),
      onApprovalRequest: (cb: NonNullable<ChatIpcCallbacks["approval"]>) => {
        callbacks.approval = cb;
        return vi.fn();
      },
      onChatUsage: (cb: Callback<[string, UsageState]>) => {
        callbacks.usage = cb;
        return vi.fn();
      },
      onContractAnalysisSessionUpdate: (
        cb: NonNullable<ChatIpcCallbacks["contractAnalysis"]>,
      ) => {
        callbacks.contractAnalysis = cb;
        return vi.fn();
      },
    },
  });

  return { getSessionMessages };
}

function Harness({
  sessionScopeId,
}: {
  sessionScopeId: string | null;
}): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [, setHermesSessionId] = useState<string | null>(sessionScopeId);
  const [, setToolProgress] = useState<string | null>(null);
  const [, setIsLoading] = useState(false);
  const [, setUsage] = useState<UsageState | null>(null);
  const activeTurnRef = useRef<ActiveTurn | null>(null);

  useChatIPC({
    runId: "run-1",
    profile: "default",
    sessionScopeId,
    setMessages,
    setHermesSessionId,
    setToolProgress,
    setIsLoading,
    setUsage,
    activeTurnRef,
  });

  return (
    <output data-testid="ids">
      {JSON.stringify(messages.map((message) => message.id))}
    </output>
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "hermesAPI");
});

describe("useChatIPC session scoping", () => {
  it("renders an approval request without ending the active turn", () => {
    const callbacks: ChatIpcCallbacks = {};
    installHermesApi(callbacks);
    render(<Harness sessionScopeId="session-1" />);

    act(() => {
      callbacks.approval?.("run-1", {
        requestId: "approval-1",
        description: "Write the report",
        command: "python generate.py",
        choices: ["once", "deny"],
      });
    });

    expect(screen.getByTestId("ids")).toHaveTextContent(
      JSON.stringify(["approval-approval-1"]),
    );
  });

  it("ignores late DB refreshes from an old session after the visible chat is cleared", async () => {
    const callbacks: ChatIpcCallbacks = {};
    const api = installHermesApi(callbacks);
    api.getSessionMessages.mockResolvedValue([]);
    const view = render(<Harness sessionScopeId="old-session" />);

    await act(async () => {
      await Promise.resolve();
    });
    const readsBeforeClear = api.getSessionMessages.mock.calls.length;

    view.rerender(<Harness sessionScopeId={null} />);

    await act(async () => {
      callbacks.done?.("run-1", "old-session");
    });

    expect(api.getSessionMessages).toHaveBeenCalledTimes(readsBeforeClear);
    expect(screen.getByTestId("ids")).toHaveTextContent("[]");
  });

  it("accepts DB refreshes for the visible session", async () => {
    const callbacks: ChatIpcCallbacks = {};
    const api = installHermesApi(callbacks);
    render(<Harness sessionScopeId="old-session" />);

    await act(async () => {
      callbacks.done?.("run-1", "old-session");
    });

    expect(api.getSessionMessages).toHaveBeenCalledWith("old-session");
    expect(screen.getByTestId("ids")).toHaveTextContent(
      JSON.stringify(["db-1", "db-2"]),
    );
  });

  it("refreshes an open contract-analysis session when its background run completes", async () => {
    const callbacks: ChatIpcCallbacks = {};
    const api = installHermesApi(callbacks);
    let completed = false;
    api.getSessionMessages.mockImplementation(async () =>
      completed
        ? [
            { kind: "user", id: 1, content: "contract prompt" },
            {
              kind: "assistant",
              id: 2,
              content: "contract result",
              finishReason: "stop",
            },
          ]
        : [{ kind: "user", id: 1, content: "contract prompt" }],
    );
    render(<Harness sessionScopeId="contract-session" />);

    await act(async () => {
      await Promise.resolve();
      completed = true;
      callbacks.contractAnalysis?.({
        profile: "default",
        sessionId: "contract-session",
        phase: "completed",
        modelOverride: {
          provider: "custom",
          model: "claude-opus-5",
          baseUrl: "https://example.invalid/v1",
        },
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId("ids")).toHaveTextContent(
      JSON.stringify(["db-1", "db-2"]),
    );
  });
});

describe("final DB transcript settling", () => {
  // @lat: [[lat.md/rag-mvp#Tests#Completion waits for the persisted terminal transcript]]
  it("keeps polling past chat-done until complete reasoning and answer are stable", async () => {
    let clock = 0;
    const snapshots = [
      [
        { kind: "user" as const, id: 1, content: "prompt" },
        { kind: "reasoning" as const, id: 2, text: "partial thought" },
        { kind: "assistant" as const, id: 2, content: "partial answer" },
      ],
      [
        { kind: "user" as const, id: 1, content: "prompt" },
        { kind: "reasoning" as const, id: 2, text: "complete thought" },
        {
          kind: "assistant" as const,
          id: 2,
          content: "complete answer",
          finishReason: "stop",
        },
      ],
    ];
    let reads = 0;
    let latest = snapshots[0];

    const settled = await settleFinalDbTranscript(
      async () => snapshots[Math.min(reads++, snapshots.length - 1)],
      (items) => {
        latest = items as typeof latest;
      },
      () => true,
      {
        maxAttempts: 5,
        pollIntervalMs: 10,
        minSettleMs: 20,
        stableReads: 2,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        now: () => clock,
      },
    );

    expect(settled).toBe(true);
    expect(reads).toBe(3);
    expect(latest).toEqual(snapshots[1]);
  });
});
