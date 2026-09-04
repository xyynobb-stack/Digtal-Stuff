import { beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ append: vi.fn(), mkdir: vi.fn() }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    appendFileSync: io.append,
    mkdirSync: io.mkdir,
    default: { ...actual, appendFileSync: io.append, mkdirSync: io.mkdir },
  };
});
vi.mock("electron", () => ({
  app: { getPath: () => "/test/logs", getVersion: () => "0.7.54" },
}));
import {
  recordInstallCheck,
  redactInstallCheckText,
} from "./install-check-log";

describe("installation check logging", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });
  it("records correlation and process outcomes", () => {
    recordInstallCheck("verify.finished", {
      checkId: "check1",
      ok: false,
      code: "ETIMEDOUT",
      killed: true,
      elapsedMs: 15001,
    });
    const record = JSON.parse(io.append.mock.calls[0][1]);
    expect(record).toMatchObject({
      stage: "verify.finished",
      checkId: "check1",
      code: "ETIMEDOUT",
      killed: true,
      version: "0.7.54",
    });
    expect(record.at).toBeTruthy();
  });
  it("redacts credentials and URLs while retaining ordinary error text", () => {
    vi.stubEnv("TEST_API_KEY", "private-value-123");
    const result = redactInstallCheckText(
      "ImportError private-value-123 Bearer credential123 token=abc123 https://example.test/?code=private",
    );
    expect(result).toContain("ImportError");
    for (const secret of [
      "private-value-123",
      "credential123",
      "abc123",
      "example.test",
    ])
      expect(result).not.toContain(secret);
    vi.unstubAllEnvs();
  });
  it("bounds error output", () => {
    expect(redactInstallCheckText("x".repeat(10000))).toHaveLength(4000);
  });
  it("does not fail the caller when logging fails", () => {
    io.append.mockImplementation(() => {
      throw Error("disk unavailable");
    });
    expect(() => recordInstallCheck("verify.started")).not.toThrow();
  });
});
