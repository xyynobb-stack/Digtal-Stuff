import { app } from "electron";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ColdStartTimingEvent } from "../shared/cold-start-timing";

interface TurnMilestones {
  sendAtMs?: number;
  promptSubmitAtMs?: number;
  firstDeltaAtMs?: number;
  apiRequestStartedAtMs?: number;
}

export interface ColdStartTimingRecord extends ColdStartTimingEvent {
  atMs: number;
  at: string;
  appStartToEventMs: number;
  runtimePrepareToEventMs?: number;
  runtimeReadyToEventMs?: number;
  dashboardSpawnToEventMs?: number;
  dashboardReadyToEventMs?: number;
  agentBuildToEventMs?: number;
  agentConstructToEventMs?: number;
  apiRequestToEventMs?: number;
  sendToEventMs?: number;
  promptSubmitToEventMs?: number;
}

/** Derive cross-process durations without touching installation or chat state. */
export class ColdStartTimingTracker {
  private runtimePrepareStartedAtMs: number | undefined;
  private runtimeReadyAtMs: number | undefined;
  private dashboardSpawnStartedAtMs: number | undefined;
  private dashboardReadyAtMs: number | undefined;
  private agentBuildStartedAtMs: number | undefined;
  private agentConstructStartedAtMs: number | undefined;
  private readonly turns = new Map<string, TurnMilestones>();

  constructor(private readonly appStartedAtMs: number) {}

  record(event: ColdStartTimingEvent): ColdStartTimingRecord {
    const atMs =
      typeof event.atMs === "number" && Number.isFinite(event.atMs)
        ? event.atMs
        : Date.now();
    const turnId = sanitizeTurnId(event.turnId);
    const normalized: ColdStartTimingEvent = {
      ...event,
      atMs,
      ...(turnId ? { turnId } : {}),
      ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
    };
    if (!turnId) delete normalized.turnId;

    if (event.stage === "runtime.prepare_started") {
      this.runtimePrepareStartedAtMs = atMs;
    }
    if (event.stage === "runtime.ready") this.runtimeReadyAtMs = atMs;
    if (event.stage === "dashboard.spawn_started") {
      this.dashboardSpawnStartedAtMs = atMs;
    }
    if (event.stage === "dashboard.ready") this.dashboardReadyAtMs = atMs;
    if (event.stage === "agent.build_started") {
      this.agentBuildStartedAtMs = atMs;
    }
    if (event.stage === "agent.construct_started") {
      this.agentConstructStartedAtMs = atMs;
    }

    let turn: TurnMilestones | undefined;
    if (turnId) {
      turn = this.turns.get(turnId) ?? {};
      if (event.stage === "chat.send") turn.sendAtMs = atMs;
      if (event.stage === "chat.prompt_submit_sent") {
        turn.promptSubmitAtMs = atMs;
      }
      if (event.stage === "chat.first_delta" && !turn.firstDeltaAtMs) {
        turn.firstDeltaAtMs = atMs;
      }
      if (event.stage === "agent.api_request_started") {
        turn.apiRequestStartedAtMs = atMs;
      }
      this.turns.set(turnId, turn);
    }

    const record: ColdStartTimingRecord = {
      ...normalized,
      atMs,
      at: new Date(atMs).toISOString(),
      appStartToEventMs: elapsed(atMs, this.appStartedAtMs),
      ...(this.runtimePrepareStartedAtMs !== undefined
        ? {
            runtimePrepareToEventMs: elapsed(
              atMs,
              this.runtimePrepareStartedAtMs,
            ),
          }
        : {}),
      ...(this.runtimeReadyAtMs !== undefined
        ? { runtimeReadyToEventMs: elapsed(atMs, this.runtimeReadyAtMs) }
        : {}),
      ...(this.dashboardSpawnStartedAtMs !== undefined
        ? {
            dashboardSpawnToEventMs: elapsed(
              atMs,
              this.dashboardSpawnStartedAtMs,
            ),
          }
        : {}),
      ...(this.dashboardReadyAtMs !== undefined
        ? { dashboardReadyToEventMs: elapsed(atMs, this.dashboardReadyAtMs) }
        : {}),
      ...(this.agentBuildStartedAtMs !== undefined
        ? { agentBuildToEventMs: elapsed(atMs, this.agentBuildStartedAtMs) }
        : {}),
      ...(this.agentConstructStartedAtMs !== undefined
        ? {
            agentConstructToEventMs: elapsed(
              atMs,
              this.agentConstructStartedAtMs,
            ),
          }
        : {}),
      ...(turn?.apiRequestStartedAtMs !== undefined
        ? {
            apiRequestToEventMs: elapsed(atMs, turn.apiRequestStartedAtMs),
          }
        : {}),
      ...(turn?.sendAtMs !== undefined
        ? { sendToEventMs: elapsed(atMs, turn.sendAtMs) }
        : {}),
      ...(turn?.promptSubmitAtMs !== undefined
        ? { promptSubmitToEventMs: elapsed(atMs, turn.promptSubmitAtMs) }
        : {}),
    };

    if (
      turnId &&
      (event.stage === "chat.complete" || event.stage === "chat.failed")
    ) {
      this.turns.delete(turnId);
    }
    return record;
  }
}

function elapsed(atMs: number, startMs: number): number {
  return Math.max(0, Math.round(atMs - startMs));
}

function sanitizeTurnId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 160);
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed) ? trimmed : undefined;
}

const tracker = new ColdStartTimingTracker(Date.now());

/** Append one small diagnostic JSON line under Electron's userData directory. */
export function recordColdStartTiming(event: ColdStartTimingEvent): void {
  try {
    const record = tracker.record(event);
    const logDir = app.getPath("userData");
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, "cold-start-timing.log"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never change installation, startup, or chat behavior.
  }
}
