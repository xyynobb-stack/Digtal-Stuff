// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { configureAIHubKey } from "../scripts/configure-aihub-key.mjs";

describe("AIHub local credential provisioning", () => {
  it("preserves other credentials and imports the backup key idempotently", () => {
    const root = mkdtempSync(join(tmpdir(), "aihub-key-test-"));
    try {
      const env = join(root, ".env");
      const source = join(root, ".env.aihub");
      writeFileSync(env, "# keep comment\nOTHER_KEY=other-value\n");
      writeFileSync(source, "AIHUB_API_KEY=sk-fake-unit-test\n");
      expect(configureAIHubKey(root, source)).toBe(true);
      expect(configureAIHubKey(root, source)).toBe(false);
      const content = readFileSync(env, "utf8");
      expect(content).toContain("# keep comment\nOTHER_KEY=other-value\n");
      expect(content.match(/AIHUB_API_KEY=/g)).toHaveLength(1);
      writeFileSync(source, "AIHUB_API_KEY=sk-replacement-test\n");
      configureAIHubKey(root, source);
      expect(readFileSync(env, "utf8")).not.toContain("sk-fake-unit-test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
