import { createHash } from "crypto";
import { describe, expect, it } from "vitest";
import { buildTextIntegrityTraceRecord } from "./text-integrity-trace";

describe("text integrity trace records", () => {
  // @lat: [[main-process#Text integrity diagnostics]]
  it("records the exact UTF-16 length and UTF-8 hash of Chinese text", () => {
    const text = "我喜欢吃饭";
    const record = buildTextIntegrityTraceRecord({
      stage: "frontend.state",
      atMs: 1_000,
      sessionId: "session-1",
      turnId: "turn-1",
      backendTurnKey: "session-1:1",
      sequence: 3,
      eventType: "message.delta",
      text,
    });

    expect(record.text).toBe(text);
    expect(record.textLength).toBe(text.length);
    expect(record.textSha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(record.textTruncated).toBe(false);
  });
});
