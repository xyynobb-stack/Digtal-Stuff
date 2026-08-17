import { describe, expect, it } from "vitest";
import { ColdStartTimingTracker } from "./cold-start-timing";

describe("ColdStartTimingTracker", () => {
  // @lat: [[main-process#Cold-start timing diagnostics]]
  it("derives cold-start, submit, first-delta, and completion durations", () => {
    const tracker = new ColdStartTimingTracker(1_000);
    tracker.record({ stage: "runtime.prepare_started", atMs: 1_500 });
    tracker.record({ stage: "runtime.ready", atMs: 2_000 });
    tracker.record({ stage: "dashboard.spawn_started", atMs: 2_200 });
    tracker.record({ stage: "dashboard.ready", atMs: 2_500 });
    tracker.record({ stage: "agent.build_started", atMs: 2_600 });
    tracker.record({ stage: "agent.construct_started", atMs: 2_700 });
    tracker.record({ stage: "chat.send", atMs: 3_000, turnId: "turn-1" });
    tracker.record({
      stage: "chat.prompt_submit_sent",
      atMs: 4_200,
      turnId: "turn-1",
    });
    tracker.record({
      stage: "agent.api_request_started",
      atMs: 4_500,
      turnId: "turn-1",
    });
    const firstDelta = tracker.record({
      stage: "chat.first_delta",
      atMs: 5_000,
      turnId: "turn-1",
      deltaKind: "message",
    });
    expect(firstDelta).toMatchObject({
      appStartToEventMs: 4_000,
      runtimePrepareToEventMs: 3_500,
      runtimeReadyToEventMs: 3_000,
      dashboardSpawnToEventMs: 2_800,
      dashboardReadyToEventMs: 2_500,
      agentBuildToEventMs: 2_400,
      agentConstructToEventMs: 2_300,
      apiRequestToEventMs: 500,
      sendToEventMs: 2_000,
      promptSubmitToEventMs: 800,
    });
    const complete = tracker.record({
      stage: "chat.complete",
      atMs: 5_600,
      turnId: "turn-1",
    });
    expect(complete.sendToEventMs).toBe(2_600);
    expect(complete.promptSubmitToEventMs).toBe(1_400);
  });

  it("drops unsafe correlation ids and bounds diagnostic detail", () => {
    const record = new ColdStartTimingTracker(0).record({
      stage: "chat.failed",
      atMs: 10,
      turnId: "bad id with spaces",
      detail: "x".repeat(800),
    });
    expect(record.turnId).toBeUndefined();
    expect(record.detail).toHaveLength(500);
  });
});
