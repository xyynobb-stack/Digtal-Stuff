import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const stagingFixture = vi.hoisted(() => ({
  home: `${process.env.TEMP || process.env.TMP || "."}\\jingyu-attachment-staging-${process.pid}`,
}));

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: stagingFixture.home,
}));

import { stageAttachmentFromPath } from "../src/main/attachment-staging";

describe("attachment staging", () => {
  let sourceRoot: string;

  beforeAll(() => {
    rmSync(stagingFixture.home, { recursive: true, force: true });
    sourceRoot = mkdtempSync(join(tmpdir(), "jingyu-attachment-source-"));
  });

  afterAll(() => {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(stagingFixture.home, { recursive: true, force: true });
  });

  it("returns a complete app-owned copy that survives removal of the source", async () => {
    const source = join(sourceRoot, "report.docx");
    const contents = Buffer.from("document bytes");
    writeFileSync(source, contents);

    const staged = await stageAttachmentFromPath(
      "run-1",
      source,
      "report.docx",
      contents.length,
    );
    rmSync(source, { force: true });

    expect(staged).not.toBe(source);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged)).toEqual(contents);
    expect(
      readdirSync(dirname(staged)).some((name) => name.includes(".part-")),
    ).toBe(false);
  });

  it("rejects a source whose byte count changed before the copy", async () => {
    const source = join(sourceRoot, "changed.pdf");
    writeFileSync(source, "changed");

    await expect(
      stageAttachmentFromPath("run-2", source, "changed.pdf", 99),
    ).rejects.toThrow("Attachment changed while being selected");
  });
});
