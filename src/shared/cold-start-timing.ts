export const COLD_START_TIMING_STAGES = [
  "desktop.ready",
  "runtime.prepare_started",
  "runtime.ready",
  "runtime.failed",
  "dashboard.spawn_started",
  "dashboard.http_ready",
  "dashboard.chat_ready",
  "dashboard.ready",
  "dashboard.failed",
  "dashboard.session_prewarm_started",
  "dashboard.session_ready",
  "dashboard.session_failed",
  "agent.build_started",
  "agent.construct_started",
  "agent.construct_ready",
  "agent.construct_failed",
  "agent.build_ready",
  "agent.build_failed",
  "agent.api_request_started",
  "agent.api_request_finished",
  "agent.api_request_failed",
  "chat.send",
  "chat.websocket_ready",
  "chat.prompt_submit_sent",
  "chat.first_delta",
  "chat.first_message_delta",
  "chat.complete",
  "chat.failed",
] as const;

export type ColdStartTimingStage = (typeof COLD_START_TIMING_STAGES)[number];

const COLD_START_TIMING_STAGE_SET = new Set<string>(COLD_START_TIMING_STAGES);

export function isColdStartTimingStage(
  value: unknown,
): value is ColdStartTimingStage {
  return typeof value === "string" && COLD_START_TIMING_STAGE_SET.has(value);
}

/** Diagnostic-only timing event. It deliberately carries no prompt text. */
export interface ColdStartTimingEvent {
  stage: ColdStartTimingStage;
  atMs?: number;
  turnId?: string;
  deltaKind?: "message" | "reasoning";
  detail?: string;
}
