export const TEXT_INTEGRITY_TRACE_STAGES = [
  "backend.emit",
  "websocket.received",
  "frontend.state",
  "database.snapshot",
] as const;

export type TextIntegrityTraceStage =
  (typeof TEXT_INTEGRITY_TRACE_STAGES)[number];

/**
 * Development-only transcript trace. Unlike cold-start timing records, this
 * may contain response text and must therefore stay behind the explicit
 * JINGYU_TEXT_TRACE=1 switch.
 */
export interface TextIntegrityTraceEvent {
  stage: TextIntegrityTraceStage;
  atMs?: number;
  sessionId?: string;
  turnId?: string;
  backendTurnKey?: string;
  sequence?: number;
  eventType?: string;
  text?: string;
  detail?: string;
}

export function isTextIntegrityTraceStage(
  value: unknown,
): value is TextIntegrityTraceStage {
  return (
    typeof value === "string" &&
    (TEXT_INTEGRITY_TRACE_STAGES as readonly string[]).includes(value)
  );
}
