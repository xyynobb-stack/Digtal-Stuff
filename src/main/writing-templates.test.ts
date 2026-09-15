// @vitest-environment node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  home: `${process.env.TEMP || "C:\\tmp"}\\hermes-writing-templates-${process.pid}`,
}));

vi.mock("./utils", () => ({
  profileHome: (profile?: string) =>
    profile ? join(mocks.home, "profiles", profile) : mocks.home,
}));

import {
  deleteWritingTemplate,
  importWritingTemplate,
  listWritingTemplates,
} from "./writing-templates";

describe("writing template deletion", () => {
  beforeEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
    mkdirSync(mocks.home, { recursive: true });
  });

  afterEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  it("deletes only the validated template directory in the selected profile", () => {
    // @lat: [[discover#Writing templates entry]]
    const source = join(mocks.home, "source.docx");
    writeFileSync(source, "template", "utf8");
    const imported = importWritingTemplate(source, "employee-a");
    expect(imported.success).toBe(true);
    expect(imported.template).toBeDefined();

    const templateDirectory = dirname(imported.template!.path);
    expect(deleteWritingTemplate(imported.template!.id, "employee-a")).toEqual({
      success: true,
    });
    expect(existsSync(templateDirectory)).toBe(false);
    expect(listWritingTemplates("employee-a")).toEqual([]);
  });

  it("rejects traversal and leaves profile storage untouched", () => {
    const marker = join(mocks.home, "keep.txt");
    writeFileSync(marker, "keep", "utf8");

    expect(deleteWritingTemplate("..", "employee-a")).toEqual({
      success: false,
      error: "写作模板不存在。",
    });
    expect(existsSync(marker)).toBe(true);
  });
});
