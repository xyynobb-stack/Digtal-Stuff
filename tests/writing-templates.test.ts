// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let testHome = "";

vi.mock("../src/main/utils", () => ({
  profileHome: (profile?: string) =>
    profile ? join(testHome, "profiles", profile) : testHome,
}));

describe("writing template storage", () => {
  beforeAll(() => {
    testHome = mkdtempSync(join(tmpdir(), "jingyu-writing-templates-"));
  });

  afterAll(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it("copies the original file byte-for-byte and lists its metadata", async () => {
    const { importWritingTemplate, listWritingTemplates } =
      await import("../src/main/writing-templates");
    const source = join(testHome, "会议纪要模板.docx");
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02, 0x03]);
    writeFileSync(source, bytes);

    const result = importWritingTemplate(source, "writer");

    expect(result.success).toBe(true);
    expect(result.template?.name).toBe("会议纪要模板");
    expect(readFileSync(result.template!.path)).toEqual(bytes);
    expect(listWritingTemplates("writer")).toEqual([result.template]);
  });
});
