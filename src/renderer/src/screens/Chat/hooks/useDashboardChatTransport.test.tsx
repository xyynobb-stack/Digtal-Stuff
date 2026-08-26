import { act, render, waitFor } from "@testing-library/react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { DashboardRpcEvent } from "../dashboardGatewayClient";
import {
  ensureDashboardRuntimeSession,
  dashboardRouteMatches,
  shouldAcceptSessionReadinessSnapshot,
  submitDashboardPromptWithRecovery,
  useDashboardChatTransport,
  type AgentInitializationStatus,
} from "./useDashboardChatTransport";
import type { ActiveTurn, ChatMessage, UsageState } from "../types";

type SetUsageMock = Mock<(value: SetStateAction<UsageState | null>) => void>;

describe("dashboard prompt display text", () => {
  it("does not accept an acknowledged route with the wrong wire protocol", () => {
    const route = {
      model: "gpt-luna",
      provider: "company-platform-responses",
      route_id: "same",
    };
    expect(
      dashboardRouteMatches(
        { ...route, api_mode: "codex_responses" },
        { ...route, api_mode: "chat_completions" },
      ),
    ).toBe(false);
  });
  it("keeps the user-visible text on both the initial and recovered submit", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("session not found"))
      .mockResolvedValueOnce({ session_id: "recovered" })
      .mockResolvedValueOnce({ status: "streaming" });

    await submitDashboardPromptWithRecovery(
      { request },
      {
        sessionId: "stale",
        storedSessionId: "stored",
        text: "[Active session skills: built-in]\n...model-facing...",
        displayText: "这份附件里有什么？",
        outputDirectory: "C:\\Users\\me\\Desktop",
      },
    );

    expect(request).toHaveBeenNthCalledWith(1, "prompt.submit", {
      session_id: "stale",
      text: "[Active session skills: built-in]\n...model-facing...",
      display_text: "这份附件里有什么？",
      output_dir: "C:\\Users\\me\\Desktop",
    });
    expect(request).toHaveBeenNthCalledWith(3, "prompt.submit", {
      session_id: "recovered",
      text: "[Active session skills: built-in]\n...model-facing...",
      display_text: "这份附件里有什么？",
      output_dir: "C:\\Users\\me\\Desktop",
    });
  });
});

const dashboardMock = vi.hoisted(() => ({
  close: vi.fn(),
  connect: vi.fn(async () => undefined),
  instances: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    connected: boolean;
    request: ReturnType<typeof vi.fn>;
  }>,
  onEvent: null as ((event: DashboardRpcEvent) => void) | null,
  onClose: null as (() => void) | null,
  request: vi.fn(),
}));

vi.mock("../dashboardGatewayClient", () => ({
  DashboardGatewayClient: class MockDashboardGatewayClient {
    close = dashboardMock.close;
    connect = dashboardMock.connect;
    connected = true;
    request = dashboardMock.request;

    constructor(
      options: {
        onClose?: () => void;
        onEvent?: (event: DashboardRpcEvent) => void;
      } = {},
    ) {
      dashboardMock.onClose = options.onClose ?? null;
      dashboardMock.onEvent = options.onEvent ?? null;
      dashboardMock.instances.push(this);
    }
  },
}));

interface HarnessApi {
  activeTurnRef?: MutableRefObject<ActiveTurn | null>;
  messages?: ChatMessage[];
  selectModelIntent?: (
    provider: string,
    model: string,
    modelBaseUrl?: string,
  ) => void;
  send?: (text: string) => Promise<boolean>;
  setConnectionMode?: Dispatch<SetStateAction<"local" | "remote" | "ssh">>;
  setContextFolder?: Dispatch<SetStateAction<string | null>>;
  setMessages?: Dispatch<SetStateAction<ChatMessage[]>>;
  setModel?: Dispatch<SetStateAction<string>>;
  setProvider?: Dispatch<SetStateAction<string>>;
  triggerToolbarRerender?: () => void;
}

const activeBadTurn: ActiveTurn = {
  startIndex: 0,
  status: "running",
  turnId: "turn-bad",
  userId: "u-bad",
};

const activeRecoveryTurn: ActiveTurn = {
  startIndex: 2,
  status: "running",
  turnId: "turn-recovery",
  userId: "u-recovery",
};

function Harness({
  api,
  fallbackOnUnavailable = false,
  initialActiveTurn = activeBadTurn,
  initialConnectionMode = "local",
  initialHermesSessionId = null,
  onDashboardUnavailable,
  onAgentInitializationChange,
  onResumedModelIdentity,
  setUsage = vi.fn() as SetUsageMock,
}: {
  api: HarnessApi;
  fallbackOnUnavailable?: boolean;
  initialActiveTurn?: ActiveTurn | null;
  initialConnectionMode?: "local" | "remote" | "ssh";
  initialHermesSessionId?: string | null;
  onDashboardUnavailable?: (reason: string) => void;
  onAgentInitializationChange?: (
    status: AgentInitializationStatus | null,
  ) => void;
  onResumedModelIdentity?: (identity: {
    baseUrl: string;
    model: string;
    provider: string;
  }) => void;
  setUsage?: SetUsageMock;
}): null {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "u-bad",
      role: "user",
      content: "bad provider turn",
      turnId: "turn-bad",
    },
  ]);
  const [model, setModel] = useState("bad-model");
  const [provider, setProvider] = useState("bad-provider");
  const [connectionMode, setConnectionMode] = useState<
    "local" | "remote" | "ssh"
  >(initialConnectionMode);
  const [contextFolder, setContextFolder] = useState<string | null>(null);
  const [, setToolbarRevision] = useState(0);
  const activeTurnRef = useRef<ActiveTurn | null>(
    initialActiveTurn ? { ...initialActiveTurn } : null,
  );
  const transport = useDashboardChatTransport({
    activeTurnRef,
    contextFolder,
    resolveContextFolder: () => contextFolder,
    connectionMode,
    enabled: true,
    fallbackOnUnavailable,
    hermesSessionId: initialHermesSessionId,
    messages,
    model,
    profile: undefined,
    provider,
    setHermesSessionId: vi.fn(),
    setIsLoading: vi.fn(),
    setMessages,
    setToolProgress: vi.fn(),
    setUsage,
    onDashboardUnavailable,
    onAgentInitializationChange,
    onResumedModelIdentity,
  });

  useEffect(() => {
    // Bridge the hook's live values out to the test via the shared `api`
    // object. Object.assign mutates it in place (same reference the test
    // holds) without per-prop assignment, which the immutability rule rejects.
    Object.assign(api, {
      activeTurnRef,
      messages,
      selectModelIntent: transport.setModelSelectionIntent,
      send: transport.sendMessage,
      setConnectionMode,
      setContextFolder,
      setMessages,
      setModel,
      setProvider,
      triggerToolbarRerender: () => setToolbarRevision((value) => value + 1),
    });
  }, [
    activeTurnRef,
    api,
    messages,
    setConnectionMode,
    setContextFolder,
    setMessages,
    transport.sendMessage,
    transport.setModelSelectionIntent,
  ]);

  return null;
}

describe("session readiness snapshot ordering", () => {
  // @lat: [[chat-commands#Layered desktop readiness#Session-scoped monotonic snapshots]]
  it.each([
    {
      name: "rejects an older timestamp in the same generation",
      previous: {
        session_id: "live",
        generation: 3,
        phase: "building_agent" as const,
        updated_at_ms: 2_000,
      },
      incoming: {
        session_id: "live",
        generation: 3,
        phase: "building_agent" as const,
        updated_at_ms: 1_000,
      },
      accepted: false,
    },
    {
      name: "rejects a lower generation in the same session",
      previous: {
        session_id: "live",
        generation: 4,
        phase: "building_agent" as const,
      },
      incoming: {
        session_id: "live",
        generation: 3,
        phase: "ready" as const,
        agent_ready: true,
      },
      accepted: false,
    },
    {
      name: "rejects a same-generation terminal regression without timestamps",
      previous: {
        session_id: "live",
        generation: 4,
        phase: "ready" as const,
        agent_ready: true,
      },
      incoming: {
        session_id: "live",
        generation: 4,
        phase: "building_agent" as const,
        agent_ready: false,
      },
      accepted: false,
    },
    {
      name: "rejects a nonterminal phase regression",
      previous: {
        session_id: "live",
        generation: 4,
        phase: "building_agent" as const,
      },
      incoming: {
        session_id: "live",
        generation: 4,
        phase: "creating_session" as const,
      },
      accepted: false,
    },
    {
      name: "accepts a newer generation rebuilding the same session",
      previous: {
        session_id: "live",
        generation: 4,
        phase: "ready" as const,
        agent_ready: true,
      },
      incoming: {
        session_id: "live",
        generation: 5,
        phase: "building_agent" as const,
        agent_ready: false,
      },
      accepted: true,
    },
    {
      name: "accepts a replacement session whose generation restarted",
      previous: {
        session_id: "retired",
        generation: 9,
        phase: "ready" as const,
        agent_ready: true,
      },
      incoming: {
        session_id: "replacement",
        generation: 1,
        phase: "building_agent" as const,
        agent_ready: false,
      },
      accepted: true,
    },
    {
      name: "accepts a forward terminal transition from an older Dashboard without timestamps",
      previous: {
        session_id: "live",
        generation: 0,
        phase: "building_agent" as const,
      },
      incoming: {
        session_id: "live",
        generation: 0,
        phase: "ready" as const,
        agent_ready: true,
      },
      accepted: true,
    },
  ])("$name", ({ previous, incoming, accepted }) => {
    expect(shouldAcceptSessionReadinessSnapshot(previous, incoming, 0)).toBe(
      accepted,
    );
  });

  it("honors the model identity generation floor in the same session", () => {
    expect(
      shouldAcceptSessionReadinessSnapshot(
        {
          session_id: "live",
          generation: 4,
          phase: "building_agent",
        },
        {
          session_id: "live",
          generation: 5,
          phase: "ready",
          agent_ready: true,
        },
        6,
      ),
    ).toBe(false);
  });
});

describe("useDashboardChatTransport recovery", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onClose = null;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        freshDashboardWsUrl: vi.fn(async () => "ws://fresh-dashboard"),
        recordColdStartTiming: vi.fn(),
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  // @lat: [[chat-commands#Layered desktop readiness]]
  it("prewarms one local runtime session and reuses it for the first send", async () => {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return {
          session_id: "prewarmed-live",
          stored_session_id: "prewarmed-stored",
          info: {
            model: "bad-model",
            provider: "bad-provider",
            route_id: "route:v1:prewarmed",
          },
        };
      }
      if (method === "model.resolve") {
        return {
          model: "bad-model",
          provider: "bad-provider",
          route_id: "route:v1:prewarmed",
        };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} initialActiveTurn={null} />);

    await waitFor(() => {
      expect(
        dashboardMock.request.mock.calls.filter(
          ([method]) => method === "session.create",
        ),
      ).toHaveLength(1);
    });

    await act(async () => {
      await api.send?.("hello after prewarm");
    });

    expect(
      dashboardMock.request.mock.calls.filter(
        ([method]) => method === "session.create",
      ),
    ).toHaveLength(1);
    expect(dashboardMock.request).toHaveBeenCalledWith("prompt.submit", {
      session_id: "prewarmed-live",
      text: "hello after prewarm",
    });
  });

  it("records one session prewarm when model hydration reruns the effect", async () => {
    let releaseConnection!: () => void;
    dashboardMock.connect.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          releaseConnection = () => resolve(undefined);
        }),
    );
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return {
          session_id: "hydrated-live",
          stored_session_id: "hydrated-stored",
          info: {
            model: "hydrated-model",
            provider: "hydrated-provider",
            route_id: "route:v1:hydrated",
          },
        };
      }
      if (method === "model.resolve") {
        return {
          model: "hydrated-model",
          provider: "hydrated-provider",
          route_id: "route:v1:hydrated",
        };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} initialActiveTurn={null} />);

    await waitFor(() => expect(releaseConnection).toBeTypeOf("function"));
    act(() => {
      api.setProvider?.("hydrated-provider");
      api.setModel?.("hydrated-model");
    });
    releaseConnection();

    await waitFor(() => {
      const stages = vi
        .mocked(window.hermesAPI.recordColdStartTiming)
        .mock.calls.map(([event]) => event.stage);
      expect(
        stages.filter((stage) => stage === "dashboard.session_prewarm_started"),
      ).toHaveLength(1);
      expect(
        stages.filter((stage) => stage === "dashboard.session_ready"),
      ).toHaveLength(1);
    });
  });

  it("requests a fresh WebSocket URL immediately before connecting", async () => {
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} initialConnectionMode="remote" />);

    await act(async () => {
      await api.send?.("hello");
    });

    expect(window.hermesAPI.freshDashboardWsUrl).toHaveBeenCalledTimes(1);
    expect(dashboardMock.connect).toHaveBeenCalledWith("ws://fresh-dashboard");
  });

  // @lat: [[chat-commands#Transport connection lifecycle#Runtime session rebinding]]
  it.each(["socket-close", "session-reclaimed"] as const)(
    "resumes the stored session after %s invalidates the runtime binding",
    async (cause) => {
      dashboardMock.request.mockImplementation(async (method) => {
        if (method === "session.create") {
          return {
            session_id: "live-before-disconnect",
            stored_session_id: "stored-chat",
            info: {
              model: "bad-model",
              provider: "bad-provider",
              route_id: "route:v1:bad",
            },
          };
        }
        if (method === "session.resume") {
          return {
            session_id: "live-after-resume",
            stored_session_id: "stored-chat",
            info: {
              model: "bad-model",
              provider: "bad-provider",
              route_id: "route:v1:bad",
            },
          };
        }
        if (method === "model.identity" || method === "model.resolve") {
          return {
            model: "bad-model",
            provider: "bad-provider",
            route_id: "route:v1:bad",
          };
        }
        return {};
      });
      const api: HarnessApi = {};
      render(<Harness api={api} initialActiveTurn={null} />);

      await waitFor(() => {
        expect(dashboardMock.request).toHaveBeenCalledWith(
          "session.create",
          expect.any(Object),
        );
      });

      act(() => {
        if (cause === "socket-close") {
          dashboardMock.onClose?.();
          return;
        }
        dashboardMock.onEvent?.({
          type: "session.reclaimed",
          payload: {
            session_id: "live-before-disconnect",
            stored_session_id: "stored-chat",
            reason: "ws_orphan_reap",
          },
        });
      });

      await act(async () => {
        await api.send?.("hello after reconnect");
      });

      expect(dashboardMock.request).toHaveBeenCalledWith("session.resume", {
        session_id: "stored-chat",
        cols: 96,
      });
      expect(dashboardMock.request).toHaveBeenCalledWith("prompt.submit", {
        session_id: "live-after-resume",
        text: "hello after reconnect",
      });
      expect(
        dashboardMock.request.mock.calls.filter(
          ([method]) => method === "session.create",
        ),
      ).toHaveLength(1);
    },
  );

  it("records submit, first model output, first text output, and completion once", async () => {
    // @lat: [[main-process#Cold-start timing diagnostics]]
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("measure this turn");
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "desktop.timing",
        session_id: "live",
        payload: {
          stage: "agent.api_request_started",
          at_ms: 4_500,
          detail: "sequence=1; transport=stream",
        },
      });
      dashboardMock.onEvent?.({
        type: "reasoning.delta",
        session_id: "live",
        payload: { text: "thinking" },
      });
      dashboardMock.onEvent?.({
        type: "message.delta",
        session_id: "live",
        payload: { text: "first" },
      });
      dashboardMock.onEvent?.({
        type: "message.delta",
        session_id: "live",
        payload: { text: " second" },
      });
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { final_response: "first second" },
      });
    });

    const stages = vi
      .mocked(window.hermesAPI.recordColdStartTiming)
      .mock.calls.map(([event]) => event.stage);
    expect(
      stages.filter((stage) => stage === "chat.prompt_submit_sent"),
    ).toHaveLength(1);
    expect(
      stages.filter((stage) => stage === "agent.api_request_started"),
    ).toHaveLength(1);
    expect(window.hermesAPI.recordColdStartTiming).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "agent.api_request_started",
        atMs: 4_500,
        turnId: expect.stringMatching(/^turn-/),
        detail: "sequence=1; transport=stream",
      }),
    );
    expect(stages.filter((stage) => stage === "chat.first_delta")).toHaveLength(
      1,
    );
    expect(
      stages.filter((stage) => stage === "chat.first_message_delta"),
    ).toHaveLength(1);
    expect(stages.filter((stage) => stage === "chat.complete")).toHaveLength(1);
  });

  it("uses authoritative session readiness instead of diagnostic timing for UX", async () => {
    const building = {
      session_id: "live",
      generation: 1,
      phase: "building_agent",
      agent_ready: false,
      started_at_ms: 1_000,
    };
    dashboardMock.request.mockImplementation(async (method) => {
      if (method === "session.create") {
        return {
          session_id: "live",
          stored_session_id: "stored",
          readiness: building,
        };
      }
      if (method === "session.readiness") return building;
      return {};
    });
    const onInitializationChange = vi.fn();
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        onAgentInitializationChange={onInitializationChange}
      />,
    );

    await act(async () => {
      await api.send?.("initialize and answer");
    });
    await act(async () => {
      dashboardMock.onEvent?.({
        type: "desktop.timing",
        session_id: "live",
        payload: { stage: "agent.build_started", at_ms: 1_000 },
      });
      dashboardMock.onEvent?.({
        type: "session.readiness.changed",
        session_id: "live",
        payload: {
          ...building,
          phase: "ready",
          agent_ready: true,
          updated_at_ms: 2_000,
        },
      });
      dashboardMock.onEvent?.({
        type: "desktop.timing",
        session_id: "live",
        payload: { stage: "agent.api_request_started", at_ms: 2_100 },
      });
      dashboardMock.onEvent?.({
        type: "message.delta",
        session_id: "live",
        payload: { text: "ready" },
      });
    });

    expect(onInitializationChange.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            phase: "waiting",
            backgroundStartedAtMs: 1_000,
            blockingStartedAtMs: expect.any(Number),
          }),
        ],
        [
          expect.objectContaining({
            phase: "ready",
            backgroundStartedAtMs: 1_000,
            blockingStartedAtMs: expect.any(Number),
          }),
        ],
        [null],
      ]),
    );
  });

  it("does not regress when an older readiness RPC resolves after the ready event", async () => {
    vi.useFakeTimers();
    try {
      const building = {
        session_id: "live",
        generation: 2,
        phase: "building_agent" as const,
        agent_ready: false,
        started_at_ms: 1_000,
        updated_at_ms: 1_100,
      };
      let observeReadinessRequest = (): void => undefined;
      const readinessRequested = new Promise<void>((resolve) => {
        observeReadinessRequest = resolve;
      });
      let releaseReadiness = (): void => undefined;
      const delayedBuilding = new Promise<typeof building>((resolve) => {
        releaseReadiness = () => resolve(building);
      });
      dashboardMock.request.mockImplementation(async (method) => {
        if (method === "session.create") {
          return {
            session_id: "live",
            stored_session_id: "stored",
            readiness: building,
          };
        }
        if (method === "session.readiness") {
          observeReadinessRequest();
          return delayedBuilding;
        }
        return {};
      });
      const onInitializationChange = vi.fn();
      const api: HarnessApi = {};
      render(
        <Harness
          api={api}
          onAgentInitializationChange={onInitializationChange}
        />,
      );

      let sendPromise: Promise<boolean | undefined>;
      await act(async () => {
        sendPromise =
          api.send?.("race readiness") ?? Promise.resolve(undefined);
        await readinessRequested;
      });
      await act(async () => {
        dashboardMock.onEvent?.({
          type: "session.readiness.changed",
          session_id: "live",
          payload: {
            ...building,
            phase: "ready",
            agent_ready: true,
            updated_at_ms: 2_000,
          },
        });
        releaseReadiness();
        await sendPromise;
      });
      act(() => {
        vi.advanceTimersByTime(1_500);
      });

      const phases = onInitializationChange.mock.calls.map(
        ([status]) => status?.phase ?? null,
      );
      const readyIndex = phases.lastIndexOf("ready");
      expect(readyIndex).toBeGreaterThanOrEqual(0);
      expect(phases.slice(readyIndex + 1)).not.toContain("background");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses real model output as a terminal ready proof against delayed building snapshots", async () => {
    vi.useFakeTimers();
    try {
      const building = {
        session_id: "live",
        generation: 3,
        phase: "building_agent" as const,
        agent_ready: false,
        started_at_ms: 3_000,
        updated_at_ms: 3_100,
      };
      dashboardMock.request.mockImplementation(async (method) => {
        if (method === "session.create") {
          return {
            session_id: "live",
            stored_session_id: "stored",
            readiness: building,
          };
        }
        if (method === "session.readiness") return building;
        return {};
      });
      const onInitializationChange = vi.fn();
      const api: HarnessApi = {};
      render(
        <Harness
          api={api}
          onAgentInitializationChange={onInitializationChange}
        />,
      );

      await act(async () => {
        await api.send?.("output proves readiness");
        dashboardMock.onEvent?.({
          type: "message.delta",
          session_id: "live",
          payload: { text: "answer" },
        });
        dashboardMock.onEvent?.({
          type: "session.readiness.changed",
          session_id: "live",
          payload: {
            ...building,
            updated_at_ms: 9_000,
          },
        });
      });
      act(() => {
        vi.advanceTimersByTime(1_500);
      });

      const statuses = onInitializationChange.mock.calls.map(
        ([status]) => status,
      );
      const dismissedIndex = statuses.lastIndexOf(null);
      expect(dismissedIndex).toBeGreaterThanOrEqual(0);
      expect(
        statuses
          .slice(dismissedIndex + 1)
          .some((status) => status?.phase === "background"),
      ).toBe(false);
      expect(
        vi
          .mocked(window.hermesAPI.recordColdStartTiming)
          .mock.calls.filter(
            ([event]) => event.stage === "chat.initialization_wait_finished",
          ),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts a replacement runtime that restarts the server generation", async () => {
    let createCount = 0;
    const requests: Array<{ method: string; params: unknown }> = [];
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        createCount += 1;
        if (createCount === 1) {
          return {
            session_id: "retired-live",
            stored_session_id: "stored",
            readiness: {
              session_id: "retired-live",
              generation: 9,
              phase: "ready",
              agent_ready: true,
              started_at_ms: 1_000,
              updated_at_ms: 2_000,
            },
          };
        }
        return {
          session_id: "replacement-live",
          stored_session_id: "stored",
          readiness: {
            session_id: "replacement-live",
            generation: 1,
            phase: "building_agent",
            agent_ready: false,
            started_at_ms: 4_000,
            updated_at_ms: 4_100,
          },
        };
      }
      if (method === "session.readiness") {
        const sessionId = (params as { session_id?: string })?.session_id;
        return sessionId === "replacement-live"
          ? {
              session_id: "replacement-live",
              generation: 1,
              phase: "building_agent",
              agent_ready: false,
              started_at_ms: 4_000,
              updated_at_ms: 4_200,
            }
          : {
              session_id: "retired-live",
              generation: 9,
              phase: "ready",
              agent_ready: true,
              started_at_ms: 1_000,
              updated_at_ms: 2_100,
            };
      }
      return {};
    });
    const onInitializationChange = vi.fn();
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        onAgentInitializationChange={onInitializationChange}
      />,
    );

    await act(async () => {
      await api.send?.("first turn");
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "retired-live",
        payload: { status: "failed", error: "provider failed" },
      });
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      await api.send?.("retry on replacement");
    });

    expect(createCount).toBe(2);
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "replacement-live",
        text: "retry on replacement",
      },
    });
    expect(onInitializationChange).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "waiting",
        backgroundStartedAtMs: 4_000,
      }),
    );
  });

  it("creates a fresh Agent with the selected model instead of racing /model", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      if (method === "slash.exec") {
        throw new Error("fresh sessions must not switch through slash.exec");
      }
      return {};
    });
    const api: HarnessApi = {};
    render(<Harness api={api} />);

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello");
    });

    expect(handled).toBe(true);
    expect(requests).toContainEqual({
      method: "session.create",
      params: {
        cols: 96,
        model: "bad-model",
        provider: "bad-provider",
      },
    });
    expect(requests.some((request) => request.method === "slash.exec")).toBe(
      false,
    );
    expect(requests.some((request) => request.method === "model.options")).toBe(
      false,
    );
  });

  it("lets session.create resolve the complete custom route atomically", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      void params;
      if (method === "session.create") {
        return {
          session_id: "live",
          stored_session_id: "stored",
          info: {
            model: "glm-5.2",
            provider: "company-platform",
            requested_provider: "custom",
          },
        };
      }
      return {};
    });

    const result = await ensureDashboardRuntimeSession({
      client: {
        request: async <T = unknown,>(method: string, params?: unknown) =>
          (await request(method, params)) as T,
      },
      messages: [],
      model: "glm-5.2",
      modelBaseUrl: "https://models.company.test/v1/",
      provider: "custom",
    });

    expect(result.createdModelOverride).toEqual({
      model: "glm-5.2",
      provider: "custom",
    });
    expect(request).toHaveBeenCalledWith("session.create", {
      cols: 96,
      model: "glm-5.2",
      provider: "custom",
      base_url: "https://models.company.test/v1/",
    });
  });

  it("keeps one warm session when a generic selection resolves to any provider alias", async () => {
    // @lat: [[model-selection#Stable runtime route identity]]
    const requests: Array<{ method: string; params: unknown }> = [];
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return {
          session_id: "live",
          stored_session_id: "stored",
          info: {
            route_id: "route:v1:initial",
            model: "bad-model",
            provider: "bad-provider",
          },
        };
      }
      if (method === "model.resolve") {
        return {
          route_id: "route:v1:future-model",
          model: "future-model",
          provider: "provider-added-after-release",
        };
      }
      if (method === "model.identity") {
        return {
          route_id: "route:v1:initial",
          model: "bad-model",
          provider: "bad-provider",
        };
      }
      if (method === "session.model.set") {
        return {
          route_id: "route:v1:future-model",
          model: "future-model",
          provider: "provider-added-after-release",
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("first");
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { final_response: "first answer" },
      });
      api.setProvider?.("custom");
      api.setModel?.("future-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
    });
    await act(async () => {
      await api.send?.("second");
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { final_response: "second answer" },
      });
      api.activeTurnRef!.current = {
        ...activeRecoveryTurn,
        turnId: "turn-third",
        userId: "u-third",
      };
    });
    await act(async () => {
      await api.send?.("third");
    });

    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "model.resolve"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "session.model.set"),
    ).toEqual([
      {
        method: "session.model.set",
        params: {
          session_id: "live",
          route_id: "route:v1:future-model",
          provider: "custom",
          model: "future-model",
          base_url: undefined,
        },
      },
    ]);
  });

  it("does not rebuild the Agent after a route validation error", async () => {
    // @lat: [[model-selection#Stable runtime route identity]]
    const requests: Array<{ method: string; params: unknown }> = [];
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return {
          session_id: "live",
          stored_session_id: "stored",
          info: {
            route_id: "route:v1:initial",
            model: "bad-model",
            provider: "bad-provider",
          },
        };
      }
      if (method === "model.resolve") {
        return {
          route_id: "route:v1:wanted",
          model: "future-model",
          provider: "future-provider",
        };
      }
      if (method === "model.identity" || method === "session.model.set") {
        return {
          route_id: "route:v1:initial",
          model: "bad-model",
          provider: "bad-provider",
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await act(async () => {
      await api.send?.("first");
      dashboardMock.onEvent?.({
        type: "message.complete",
        session_id: "live",
        payload: { final_response: "first answer" },
      });
      api.setProvider?.("custom");
      api.setModel?.("future-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
    });
    await act(async () => {
      await api.send?.("route mismatch");
      api.activeTurnRef!.current = {
        ...activeRecoveryTurn,
        turnId: "turn-retry",
        userId: "u-retry",
      };
    });
    await act(async () => {
      await api.send?.("retry without rebuilding");
    });

    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.method === "session.close"),
    ).toHaveLength(0);
  });

  it("surfaces OAuth login requirements without legacy fallback", async () => {
    // @lat: [[remote-dashboard-oauth#Test specifications#OAuth no-fallback]]
    const onUnavailable = vi.fn();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          running: false,
          needsOAuthLogin: true,
          error: "Sign in with your browser.",
          connection: { authMode: "oauth", wsUrl: "" },
        })),
      },
    });
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="remote"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let handled: boolean | undefined;
    await act(async () => {
      handled = await api.send?.("hello");
    });

    expect(handled).toBe(true);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates a clean runtime after a failed provider turn", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-bad", stored_session_id: "stored-chat" };
      }
      if (method === "session.resume") {
        return { session_id: "live-recovery", resumed: "stored-chat" };
      }
      if (method === "slash.exec") {
        const command =
          params && typeof params === "object" && "command" in params
            ? String(params.command)
            : "";
        const match = command.match(/^\/model\s+(.+?)\s+--provider\s+(.+)$/);
        if (match) {
          liveModel = match[1];
          liveProvider = match[2];
        }
        return {};
      }
      if (method === "model.identity") {
        return { model: liveModel, provider: liveProvider };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("bad provider turn");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          error: "Invalid API Key",
          status: "error",
        },
        session_id: "live-bad",
        type: "message.complete",
      });
    });

    const badSend = api.send;
    await act(async () => {
      api.setProvider?.("good-provider");
      api.setModel?.("good-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-recovery",
          role: "user",
          content: "recovery turn",
          turnId: "turn-recovery",
        },
      ]);
    });
    await waitFor(() => expect(api.send).not.toBe(badSend));

    await act(async () => {
      await api.send?.("recovery turn");
    });

    expect(requests).not.toContainEqual({
      method: "session.resume",
      params: { session_id: "stored-chat", cols: 96 },
    });
    expect(
      requests.filter((request) => request.method === "session.create"),
    ).toEqual([
      {
        method: "session.create",
        params: {
          cols: 96,
          model: "bad-model",
          provider: "bad-provider",
        },
      },
      {
        method: "session.create",
        params: {
          cols: 96,
          model: "good-model",
          provider: "good-provider",
        },
      },
    ]);
    expect(requests).not.toContainEqual({
      method: "session.create",
      params: {
        cols: 96,
        messages: [
          { role: "user", content: "bad provider turn" },
          { role: "assistant", content: "Error: Invalid API Key" },
        ],
      },
    });
    expect(window.hermesAPI.recordSessionLocalError).toHaveBeenCalledWith(
      "stored-chat",
      {
        error: "Invalid API Key",
        userContent: "bad provider turn",
      },
    );
    expect(window.hermesAPI.recordSessionContinuation).toHaveBeenCalledWith(
      "stored-chat",
      [
        { kind: "user", content: "bad provider turn" },
        { kind: "assistant", content: "", error: "Invalid API Key" },
      ],
    );
  });

  it("uses the latest picker model when the composer calls a stale send callback", async () => {
    // @lat: [[model-selection#Latest picker identity wins]]
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      if (method === "model.identity") {
        return { model: liveModel, provider: liveProvider };
      }
      if (method === "session.model.set") {
        liveModel = String((params as { model?: string })?.model || "");
        liveProvider = String(
          (params as { provider?: string })?.provider || "",
        );
        return { model: liveModel, provider: liveProvider };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    await act(async () => {
      await api.send?.("first turn");
    });
    const staleSend = api.send;

    await act(async () => {
      api.setProvider?.("good-provider");
      api.setModel?.("good-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
    });

    await act(async () => {
      await staleSend?.("sent by an input holding the previous callback");
    });

    expect(requests).toContainEqual({
      method: "session.model.set",
      params: {
        session_id: "live",
        model: "good-model",
        provider: "good-provider",
        base_url: undefined,
      },
    });
    expect(requests).toContainEqual({
      method: "prompt.submit",
      params: {
        session_id: "live",
        text: "sent by an input holding the previous callback",
      },
    });
    expect(requests.some((request) => request.method === "model.options")).toBe(
      false,
    );
  });

  it("uses a picker intent that React has not rendered before an immediate send", async () => {
    // @lat: [[model-selection#Latest picker identity wins#Picker intent precedes React commit]]
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return {
          session_id: "new-live",
          stored_session_id: "new-stored",
          info: {
            route_id: "route:v1:bad-provider:bad-model",
            model: liveModel,
            provider: liveProvider,
          },
        };
      }
      if (method === "model.resolve") {
        const selected = params as { model?: string; provider?: string };
        return {
          route_id: `route:v1:${selected.provider}:${selected.model}`,
          model: selected.model,
          provider: selected.provider,
        };
      }
      if (method === "model.identity") {
        return { model: liveModel, provider: liveProvider };
      }
      if (method === "session.model.set") {
        liveModel = String((params as { model?: string }).model || "");
        liveProvider = String((params as { provider?: string }).provider || "");
        return {
          route_id: `route:v1:${liveProvider}:${liveModel}`,
          model: liveModel,
          provider: liveProvider,
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} initialActiveTurn={null} />);

    await waitFor(() => {
      expect(window.hermesAPI.recordColdStartTiming).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "dashboard.session_ready" }),
      );
    });

    await act(async () => {
      // Do not update Harness props: this is the interval between the picker
      // callback and React committing the corresponding model/provider state.
      // A skill/template selection can finish another state update in exactly
      // this interval; that unrelated render must not restore the old route.
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      api.selectModelIntent?.("qwen-provider", "qwen3.5-plus");
      api.triggerToolbarRerender?.();
      await api.send?.("which model are you");
    });

    const mutations = requests.filter(
      (request) =>
        request.method === "session.model.set" ||
        request.method === "prompt.submit",
    );
    expect(mutations).toEqual([
      {
        method: "session.model.set",
        params: {
          session_id: "new-live",
          route_id: "route:v1:qwen-provider:qwen3.5-plus",
          provider: "qwen-provider",
          model: "qwen3.5-plus",
          base_url: undefined,
        },
      },
      {
        method: "prompt.submit",
        params: {
          session_id: "new-live",
          text: "which model are you",
        },
      },
    ]);
  });

  it("keeps the picker route when a folder update reruns session prewarm", async () => {
    // @lat: [[model-selection#Latest picker identity wins#Toolbar context changes cannot overwrite picker intent]]
    const requests: Array<{ method: string; params: unknown }> = [];
    let liveModel = "bad-model";
    let liveProvider = "bad-provider";
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return {
          session_id: "live",
          stored_session_id: "stored",
          info: {
            route_id: "route:v1:bad-provider:bad-model",
            model: liveModel,
            provider: liveProvider,
          },
        };
      }
      if (method === "model.resolve") {
        return {
          route_id: "route:v1:good-provider:good-model",
          model: "good-model",
          provider: "good-provider",
        };
      }
      if (method === "model.identity") {
        return {
          route_id: `route:v1:${liveProvider}:${liveModel}`,
          model: liveModel,
          provider: liveProvider,
        };
      }
      if (method === "session.model.set") {
        liveModel = "good-model";
        liveProvider = "good-provider";
        return {
          route_id: "route:v1:good-provider:good-model",
          model: liveModel,
          provider: liveProvider,
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} initialActiveTurn={null} />);
    await waitFor(() => {
      expect(window.hermesAPI.recordColdStartTiming).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "dashboard.session_ready" }),
      );
    });

    await act(async () => {
      api.setContextFolder?.("C:\\workspace\\new-context");
    });
    await act(async () => {
      // The preceding folder update has rerun the prewarm path; the subsequent
      // picker event must still become the route barrier for this Send.
      api.selectModelIntent?.("good-provider", "good-model");
      api.activeTurnRef!.current = { ...activeRecoveryTurn };
      await api.send?.("use the selected folder and model");
    });

    expect(requests).toContainEqual({
      method: "session.cwd.set",
      params: {
        session_id: "live",
        cwd: "C:\\workspace\\new-context",
      },
    });
    expect(requests).toContainEqual({
      method: "session.model.set",
      params: {
        session_id: "live",
        route_id: "route:v1:good-provider:good-model",
        provider: "good-provider",
        model: "good-model",
        base_url: undefined,
      },
    });
    expect(requests.at(-1)).toEqual({
      method: "prompt.submit",
      params: {
        session_id: "live",
        text: "use the selected folder and model",
      },
    });
  });

  it("uses the authoritative resumed route before an immediate send", async () => {
    // @lat: [[model-selection#Latest picker identity wins#Resumed route beats the temporary default]]
    const requests: Array<{ method: string; params: unknown }> = [];
    const onResumedModelIdentity = vi.fn();
    const resumedIdentity = {
      route_id: "route:v1:company-platform:qwen3.5-plus",
      requested_provider: "custom",
      provider: "company-platform",
      model: "qwen3.5-plus",
      base_url: "https://company.example/v1",
      selection_generation: 7,
    };
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        return {
          session_id: "live-resumed",
          resumed: "stored-resumed",
          info: { model: "bad-model", provider: "bad-provider" },
        };
      }
      if (method === "model.identity") return resumedIdentity;
      return {};
    });

    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialHermesSessionId="stored-resumed"
        onResumedModelIdentity={onResumedModelIdentity}
      />,
    );

    await act(async () => {
      await api.send?.("keep this conversation model");
    });

    expect(onResumedModelIdentity).toHaveBeenCalledWith({
      baseUrl: "https://company.example/v1",
      model: "qwen3.5-plus",
      provider: "custom",
    });
    expect(requests).toContainEqual({
      method: "session.resume",
      params: { session_id: "stored-resumed", cols: 96 },
    });
    expect(
      requests.some((request) => request.method === "session.model.set"),
    ).toBe(false);
    expect(requests.at(-1)).toEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-resumed",
        text: "keep this conversation model",
      },
    });
  });

  it("keeps an explicit picker choice made while resume identity is pending", async () => {
    // @lat: [[model-selection#Latest picker identity wins#Explicit picker beats asynchronous restoration]]
    const requests: Array<{ method: string; params: unknown }> = [];
    const onResumedModelIdentity = vi.fn();
    let releaseResumeIdentity = (): void => undefined;
    const resumeIdentityBlocked = new Promise<void>((resolve) => {
      releaseResumeIdentity = resolve;
    });
    let resumeIdentityStarted = (): void => undefined;
    const resumeIdentityObserved = new Promise<void>((resolve) => {
      resumeIdentityStarted = resolve;
    });
    let identityCalls = 0;
    let liveModel = "old-model";
    let liveProvider = "old-provider";

    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.resume") {
        return { session_id: "live-resumed", resumed: "stored-resumed" };
      }
      if (method === "model.identity") {
        const identityCall = ++identityCalls;
        if (identityCall === 1) {
          resumeIdentityStarted();
          await resumeIdentityBlocked;
        }
        return {
          route_id: `route:v1:${liveProvider}:${liveModel}`,
          model: liveModel,
          provider: liveProvider,
        };
      }
      if (method === "model.resolve") {
        return {
          route_id: "route:v1:good-provider:good-model",
          model: "good-model",
          provider: "good-provider",
        };
      }
      if (method === "session.model.set") {
        liveModel = "good-model";
        liveProvider = "good-provider";
        return {
          route_id: "route:v1:good-provider:good-model",
          model: "good-model",
          provider: "good-provider",
          selection_generation: 8,
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialHermesSessionId="stored-resumed"
        onResumedModelIdentity={onResumedModelIdentity}
      />,
    );

    let sendPromise: Promise<boolean | undefined>;
    await act(async () => {
      sendPromise =
        api.send?.("use my new picker choice") ?? Promise.resolve(undefined);
      await resumeIdentityObserved;
      api.selectModelIntent?.("good-provider", "good-model");
    });
    releaseResumeIdentity();
    await act(async () => {
      await sendPromise;
    });

    expect(onResumedModelIdentity).not.toHaveBeenCalled();
    expect(requests).toContainEqual({
      method: "session.model.set",
      params: {
        session_id: "live-resumed",
        route_id: "route:v1:good-provider:good-model",
        provider: "good-provider",
        model: "good-model",
        base_url: undefined,
      },
    });
    expect(requests.at(-1)).toEqual({
      method: "prompt.submit",
      params: {
        session_id: "live-resumed",
        text: "use my new picker choice",
      },
    });
  });

  it("lets the latest picker generation win an in-flight route resolution", async () => {
    // @lat: [[model-selection#Latest picker identity wins#In-flight resolution cannot overwrite a newer pick]]
    const requests: Array<{ method: string; params: unknown }> = [];
    let releaseOldRoute = (): void => undefined;
    const oldRouteBlocked = new Promise<void>((resolve) => {
      releaseOldRoute = resolve;
    });
    let oldRouteStarted = (): void => undefined;
    const oldRouteObserved = new Promise<void>((resolve) => {
      oldRouteStarted = resolve;
    });

    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live", stored_session_id: "stored" };
      }
      if (method === "model.resolve") {
        const requested = params as { model?: string };
        if (requested.model === "bad-model") {
          oldRouteStarted();
          await oldRouteBlocked;
          return {
            route_id: "route:v1:old",
            model: "bad-model",
            provider: "bad-provider",
          };
        }
        return {
          route_id: "route:v1:latest",
          model: "good-model",
          provider: "good-provider",
        };
      }
      if (method === "model.identity") {
        return {
          route_id: "route:v1:old",
          model: "bad-model",
          provider: "bad-provider",
        };
      }
      if (method === "session.model.set") {
        return {
          route_id: "route:v1:latest",
          model: "good-model",
          provider: "good-provider",
        };
      }
      return {};
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);
    let sendPromise: Promise<boolean | undefined>;
    await act(async () => {
      sendPromise = api.send!("use the latest route");
      await oldRouteObserved;
      api.setProvider?.("good-provider");
      api.setModel?.("good-model");
    });
    releaseOldRoute();
    await act(async () => {
      await sendPromise!;
    });

    const mutations = requests.filter(
      (request) =>
        request.method === "session.model.set" ||
        request.method === "prompt.submit",
    );
    expect(mutations).toEqual([
      {
        method: "session.model.set",
        params: {
          session_id: "live",
          route_id: "route:v1:latest",
          provider: "good-provider",
          model: "good-model",
          base_url: undefined,
        },
      },
      {
        method: "prompt.submit",
        params: { session_id: "live", text: "use the latest route" },
      },
    ]);
  });

  // @lat: [[model-selection#Employee phone model allowlist#Delayed cross-protocol switch]]
  it.each([
    ["deepseek-v4-flash", "gpt-5.6-luna"],
    ["gpt-5.6-luna", "deepseek-v4-flash"],
  ])(
    "waits for the latest route when %s to %s races a switch acknowledgement",
    async (first, latest) => {
      let release!: () => void;
      let observed!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const identity = (model: string) => ({
        model,
        provider: model.startsWith("gpt")
          ? "company-platform-responses"
          : "company-platform",
        api_mode: model.startsWith("gpt")
          ? "codex_responses"
          : "chat_completions",
        route_id: `route:${model}`,
      });
      let live = identity("unselected");
      const submitted: (typeof live)[] = [];
      dashboardMock.request.mockImplementation(async (method, params) => {
        if (method === "session.create")
          return { session_id: "live", stored_session_id: "stored" };
        if (method === "model.resolve") return identity(params.model);
        if (method === "model.identity") return live;
        if (method === "session.model.set") {
          if (params.model === first) {
            observed();
            await blocked;
          }
          live = identity(params.model);
          return live;
        }
        if (method === "prompt.submit") submitted.push(live);
        return {};
      });
      const api: HarnessApi = {};
      render(<Harness api={api} />);
      let sending!: Promise<boolean>;
      await act(async () => {
        api.selectModelIntent!("custom", first, "http://company.example/v1");
        sending = api.send!("use latest protocol");
        await started;
        api.selectModelIntent!("custom", latest, "http://company.example/v1");
      });
      expect(submitted).toHaveLength(0);
      release();
      await act(async () => {
        await sending;
      });
      expect(submitted).toEqual([identity(latest)]);
    },
  );

  it("discards an in-flight dashboard client after the connection mode changes", async () => {
    let releaseFirstConnect: (() => void) | null = null;
    const requests: Array<{ method: string; params: unknown }> = [];

    dashboardMock.connect
      .mockImplementationOnce(
        () =>
          new Promise<undefined>((resolve) => {
            releaseFirstConnect = () => resolve(undefined);
          }),
      )
      .mockImplementation(async () => undefined);
    dashboardMock.request.mockImplementation(async (method, params) => {
      requests.push({ method, params });
      if (method === "session.create") {
        return { session_id: "live-new", stored_session_id: "stored-new" };
      }
      if (method === "model.identity") {
        return { model: "bad-model", provider: "bad-provider" };
      }
      return {};
    });

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi
          .fn()
          .mockResolvedValueOnce({
            connection: { wsUrl: "ws://old-dashboard" },
            running: true,
          })
          .mockResolvedValue({
            connection: { wsUrl: "ws://new-dashboard" },
            running: true,
          }),
      },
    });

    const api: HarnessApi = {};
    render(<Harness api={api} />);

    let firstSend: Promise<boolean> | null = null;
    await act(async () => {
      firstSend = api.send?.("first prompt") ?? null;
    });
    await waitFor(() =>
      expect(window.hermesAPI.startDashboard).toHaveBeenCalledTimes(1),
    );

    await act(async () => {
      api.setConnectionMode?.("remote");
    });

    await act(async () => {
      releaseFirstConnect?.();
      await firstSend;
    });

    expect(dashboardMock.close).toHaveBeenCalled();

    await act(async () => {
      api.activeTurnRef!.current = {
        startIndex: api.messages?.length ?? 0,
        status: "running",
        turnId: "turn-new",
        userId: "u-new",
      };
      api.setMessages?.((prev) => [
        ...prev,
        {
          id: "u-new",
          role: "user",
          content: "new prompt",
          turnId: "turn-new",
        },
      ]);
    });

    await act(async () => {
      await api.send?.("new prompt");
    });

    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      1,
      "ws://old-dashboard",
    );
    expect(dashboardMock.connect).toHaveBeenNthCalledWith(
      2,
      "ws://new-dashboard",
    );
    expect(requests.map((request) => request.method)).toContain(
      "prompt.submit",
    );
  });
});

describe("useDashboardChatTransport unavailable fallback (issue #667)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function mockStartDashboard(): ReturnType<typeof vi.fn> {
    const startDashboard = vi.fn(async () => ({
      running: false,
      error: "JingYuAI dashboard chat WebSocket is unavailable (404)",
    }));
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard,
      },
    });
    return startDashboard;
  }

  it("latches unavailable on SSH and fails fast on later sends, notifying once", async () => {
    const startDashboard = mockStartDashboard();
    const onUnavailable = vi.fn();
    const api: HarnessApi = {};
    render(
      <Harness
        api={api}
        initialConnectionMode="ssh"
        fallbackOnUnavailable
        onDashboardUnavailable={onUnavailable}
      />,
    );

    let first: boolean | undefined;
    await act(async () => {
      first = await api.send?.("hello");
    });
    // Dashboard unavailable → caller falls back to legacy (returns false).
    expect(first).toBe(false);
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);

    let second: boolean | undefined;
    await act(async () => {
      second = await api.send?.("again");
    });
    expect(second).toBe(false);
    // Fast path: no second status/probe round-trip, no duplicate notice.
    expect(startDashboard).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("re-probes after the connection changes", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="ssh" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    expect(startDashboard).toHaveBeenCalledTimes(1);

    // Switching connection clears the sticky flag → the dashboard is retried.
    await act(async () => {
      api.setConnectionMode?.("remote");
    });
    await act(async () => {
      await api.send?.("after change");
    });
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying on local (does not latch)", async () => {
    const startDashboard = mockStartDashboard();
    const api: HarnessApi = {};
    render(
      <Harness api={api} initialConnectionMode="local" fallbackOnUnavailable />,
    );

    await act(async () => {
      await api.send?.("hello");
    });
    await act(async () => {
      await api.send?.("again");
    });
    // Local dashboard may still be spawning, so each send re-checks.
    expect(startDashboard).toHaveBeenCalledTimes(2);
  });
});

describe("useDashboardChatTransport messagesRef sync", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // `background.complete` appends an agent bubble built from `messagesRef.current`,
  // so it reads exactly the array the sync effect maintains — a clean probe for
  // whether the ref adopted an external Chat-state change. It requires a live
  // gateway client, so every test connects with one `send` first (which does not
  // append a user bubble — Chat owns that).
  const connect = async (api: HarnessApi): Promise<void> => {
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    await act(async () => {
      await api.send?.("hello");
    });
    expect(dashboardMock.onEvent).toBeTypeOf("function");
  };

  const backgroundComplete = async (): Promise<void> => {
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { task_id: "t1", text: "bg answer" },
        type: "background.complete",
      });
    });
  };

  it("adopts an external clear so a new turn does not resurrect deleted messages (#757)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Chat's `handleClear` empties the list without unmounting <Chat>. A length
    // guard (`messages.length > ref.length`) would skip this and leave the ref
    // pointing at the deleted turn, so the next event would append onto it.
    await act(async () => {
      api.setMessages?.([]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(1);
    expect(api.messages?.[0]?.id).toBe("bg-t1");
  });

  it("adopts a same-length in-place replacement (clarify resolve / edit)", async () => {
    const api: HarnessApi = {};
    render(<Harness api={api} />);
    await connect(api);

    // Same length, different content — mirrors `handleClarifyResolved` mapping a
    // clarify card to resolved before the gateway resumes the turn.
    await act(async () => {
      api.setMessages?.([
        { id: "u-edited", role: "user", content: "edited turn" },
      ]);
    });
    await backgroundComplete();

    expect(api.messages).toHaveLength(2);
    expect(api.messages?.[0]?.id).toBe("u-edited");
    expect(api.messages?.[1]?.id).toBe("bg-t1");
  });
});

describe("useDashboardChatTransport context gauge estimate (no usage payload)", () => {
  beforeEach(() => {
    dashboardMock.close.mockClear();
    dashboardMock.connect.mockClear();
    dashboardMock.instances.length = 0;
    dashboardMock.onEvent = null;
    dashboardMock.request.mockReset();
    dashboardMock.request.mockImplementation(async (method: string) => {
      if (method === "session.create") {
        return { session_id: "live-1", stored_session_id: "stored-1" };
      }
      return {};
    });
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        recordSessionContinuation: vi.fn(async () => true),
        recordSessionLocalError: vi.fn(async () => true),
        startDashboard: vi.fn(async () => ({
          connection: { wsUrl: "ws://127.0.0.1:12345" },
          running: true,
        })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Resolve the final usage object a setUsage((prev) => next) call produces.
  const lastUsage = (setUsage: SetUsageMock): UsageState | null => {
    expect(setUsage).toHaveBeenCalled();
    const updater = setUsage.mock.calls.at(-1)?.[0];
    if (typeof updater !== "function") {
      throw new Error("setUsage was not called with an updater function");
    }
    return updater(null);
  };

  it("sets an estimated contextTokens when a successful completion has no usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    // Provider omitted usage entirely → usageFromPayload returns null. The
    // gauge only renders when contextTokens is set, so the estimate must fill
    // it in — this was the case the gauge went blank on (#789).
    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "completed", final_response: "hi there" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBeGreaterThan(0);
  });

  it("prefers exact payload usage over the estimate", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: {
          status: "completed",
          final_response: "hi there",
          usage: { input: 5000, output: 200, context_used: 45000 },
        },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    const usage = lastUsage(setUsage);
    expect(usage?.contextTokens).toBe(45000);
  });

  it("does not fabricate usage for a failed turn without usage", async () => {
    const setUsage = vi.fn() as SetUsageMock;
    const api: HarnessApi = {};
    render(<Harness api={api} setUsage={setUsage} />);
    await act(async () => {
      await api.send?.("hello");
    });

    await act(async () => {
      dashboardMock.onEvent?.({
        payload: { status: "error", error: "Invalid API Key" },
        session_id: "live-1",
        type: "message.complete",
      });
    });

    expect(setUsage).not.toHaveBeenCalled();
  });
});
