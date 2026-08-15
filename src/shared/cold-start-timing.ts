export const COLD_START_TIMING_STAGES = [
  "desktop.ready",
  "runtime.prepare_started",
  "runtime.ready",
  "runtime.failed",
  "dashboard.spawn_started",
  "dashboard.ready",
  "dashboard.failed",
  "chat.send",
  "chat.websocket_ready",
  "chat.prompt_submit_sent",
  "chat.first_delta",
  "chat.first_message_delta",
  "chat.complete",
  "chat.failed",
] as const;

export type ColdStartTimingStage = (typeof COLD_START_TIMING_STAGES)[number];

/** Diagnostic-only timing event. It deliberately carries no prompt text. */
export interface ColdStartTimingEvent {
  stage: ColdStartTimingStage;
  atMs?: number;
  turnId?: string;
  deltaKind?: "message" | "reasoning";
  detail?: string;
}
