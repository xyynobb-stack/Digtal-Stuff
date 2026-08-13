// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
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

  it("persists an optional description in metadata", async () => {
    const { importWritingTemplate, updateWritingTemplateDescription } =
      await import("../src/main/writing-templates");
    const source = join(testHome, "租赁合同.docx");
    writeFileSync(source, Buffer.from("contract"));

    const result = importWritingTemplate(source, "writer");
    const updated = updateWritingTemplateDescription(
      result.template!.id,
      "用于服务器设备租赁的标准合同",
      "writer",
    );

    expect(updated?.description).toBe("用于服务器设备租赁的标准合同");
    expect(
      JSON.parse(
        readFileSync(
          join(
            testHome,
            "profiles",
            "writer",
            "writing-templates",
            result.template!.id,
            "metadata.json",
          ),
          "utf8",
        ),
      ).description,
    ).toBe("用于服务器设备租赁的标准合同");
  });

  it("replaces the stored source file and preserves its description", async () => {
    const {
      importWritingTemplate,
      replaceWritingTemplateFile,
      updateWritingTemplateDescription,
    } = await import("../src/main/writing-templates");
    const original = join(testHome, "original-contract.docx");
    const replacement = join(testHome, "updated-contract.pdf");
    writeFileSync(original, Buffer.from("old"));
    writeFileSync(replacement, Buffer.from("new"));

    const imported = importWritingTemplate(original, "writer");
    updateWritingTemplateDescription(
      imported.template!.id,
      "Standard rental contract",
      "writer",
    );
    const replaced = replaceWritingTemplateFile(
      imported.template!.id,
      replacement,
      "writer",
    );

    expect(replaced.success).toBe(true);
    expect(replaced.template).toMatchObject({
      id: imported.template!.id,
      name: "updated-contract",
      fileName: "updated-contract.pdf",
      extension: "pdf",
      description: "Standard rental contract",
    });
    expect(readFileSync(replaced.template!.path, "utf8")).toBe("new");
    expect(existsSync(imported.template!.path)).toBe(false);
  });
});
