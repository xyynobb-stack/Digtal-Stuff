import { createHash } from "crypto";
import { app } from "electron";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { TextIntegrityTraceEvent } from "../shared/text-integrity-trace";

const TRACE_FILE_NAME = "text-integrity-trace.log";
const MAX_TRACE_TEXT_CHARS = 512_000;

export interface TextIntegrityTraceRecord extends TextIntegrityTraceEvent {
  atMs: number;
  at: string;
  source: "desktop";
  textLength: number;
  textSha256: string;
  textTruncated: boolean;
}

export function textIntegrityTraceEnabled(): boolean {
  return process.env.JINGYU_TEXT_TRACE === "1";
}

export function textIntegrityTraceFilePath(): string {
  return join(app.getPath("userData"), TRACE_FILE_NAME);
}

function safeId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 240);
  return /^[a-zA-Z0-9._:-]+$/.test(normalized) ? normalized : undefined;
}

export function buildTextIntegrityTraceRecord(
  event: TextIntegrityTraceEvent,
): TextIntegrityTraceRecord {
  const atMs =
    typeof event.atMs === "number" && Number.isFinite(event.atMs)
      ? event.atMs
      : Date.now();
  const fullText = typeof event.text === "string" ? event.text : "";
  const text = fullText.slice(0, MAX_TRACE_TEXT_CHARS);
  const turnId = safeId(event.turnId);
  const sessionId = safeId(event.sessionId);
  const backendTurnKey = safeId(event.backendTurnKey);
  return {
    ...event,
    atMs,
    at: new Date(atMs).toISOString(),
    source: "desktop",
    text,
    textLength: fullText.length,
    textSha256: createHash("sha256").update(fullText).digest("hex"),
    textTruncated: text.length !== fullText.length,
    ...(turnId ? { turnId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(backendTurnKey ? { backendTurnKey } : {}),
    ...(event.detail ? { detail: event.detail.slice(0, 1_000) } : {}),
  };
}

// @lat: [[main-process#Text integrity diagnostics]]
export function recordTextIntegrityTrace(
  event: TextIntegrityTraceEvent,
): void {
  if (!textIntegrityTraceEnabled()) return;
  try {
    const logPath = textIntegrityTraceFilePath();
    mkdirSync(app.getPath("userData"), { recursive: true });
    appendFileSync(
      logPath,
      `${JSON.stringify(buildTextIntegrityTraceRecord(event))}\n`,
      "utf8",
    );
  } catch {
    // Diagnostics must never alter transport, rendering, or persistence.
  }
}
