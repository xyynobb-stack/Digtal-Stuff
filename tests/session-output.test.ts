import { describe, expect, it } from "vitest";
import { normalizeSessionOutputDestination } from "../src/shared/session-output";
import zhChat from "../src/shared/i18n/locales/zh-CN/chat";

describe("session output destination", () => {
  // @lat: [[context-folder#Output destination]]
  it("defaults to the desktop", () => {
    expect(normalizeSessionOutputDestination(undefined, "C:\\work")).toBe(
      "desktop",
    );
  });

  it("uses the context folder only while a folder is selected", () => {
    expect(
      normalizeSessionOutputDestination("context-folder", "C:\\work"),
    ).toBe("context-folder");
    expect(normalizeSessionOutputDestination("context-folder", null)).toBe(
      "desktop",
    );
  });

  it("ships Chinese labels for the folder menu", () => {
    expect(zhChat.contextFolderRecent).toBe("最近使用");
    expect(zhChat.contextFolderOpen).toBe("打开文件夹…");
  });
});
