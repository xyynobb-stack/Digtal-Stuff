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
  "agent.phase_started",
  "agent.phase_ready",
  "agent.phase_failed",
  "agent.build_ready",
  "agent.build_failed",
  "agent.api_request_started",
  "agent.api_request_finished",
  "agent.api_request_failed",
  "attachment.ingest_started",
  "attachment.file_started",
  "attachment.file_ready",
  "attachment.file_failed",
  "attachment.ingest_finished",
  "attachment.submit_snapshot",
  "attachment.dashboard_sync_started",
  "attachment.dashboard_item_started",
  "attachment.dashboard_item_ready",
  "attachment.dashboard_item_failed",
  "attachment.dashboard_sync_finished",
  "attachment.transport_fallback",
  "attachment.legacy_send_started",
  "attachment.legacy_send_dispatched",
  "attachment.legacy_send_failed",
  "chat.send",
  "chat.initialization_wait_started",
  "chat.initialization_wait_finished",
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
  sessionId?: string;
  generation?: number;
  deltaKind?: "message" | "reasoning";
  detail?: string;
}
