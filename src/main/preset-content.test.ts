import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPackagedPresetContent } from "./preset-content";

const testRoot = join(
  process.env.TEMP || "C:\\tmp",
  `hermes-preset-content-${process.pid}`,
);
const presetRoot = join(testRoot, "preset");
const hermesHome = join(testRoot, "home");

function writeFixture(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

describe("packaged preset user content", () => {
  beforeEach(() => rmSync(testRoot, { recursive: true, force: true }));
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it("copies skills and templates once without replacing user-owned entries", () => {
    // @lat: [[main-process#Packaged preset user content]]
    writeFixture(
      join(presetRoot, "skills", "custom", "recruiting", "SKILL.md"),
      "preset skill",
    );
    writeFixture(
      join(
        presetRoot,
        "skills",
        "custom",
        "finance",
        "agents",
        "openai.yaml",
      ),
      "nested skill asset",
    );
    writeFixture(
      join(presetRoot, "skills", "custom", "finance", "SKILL.md"),
      "finance skill",
    );
    writeFixture(
      join(
        presetRoot,
        "writing-templates",
        "weekly-report-123",
        "weekly-report.docx",
      ),
      "preset template",
    );
    writeFixture(
      join(hermesHome, "skills", "custom", "recruiting", "SKILL.md"),
      "user skill",
    );

    const first = installPackagedPresetContent(presetRoot, hermesHome);

    expect(first).toEqual({ skillsCopied: 1, templatesCopied: 1 });
    expect(
      readFileSync(
        join(hermesHome, "skills", "custom", "recruiting", "SKILL.md"),
        "utf8",
      ),
    ).toBe("user skill");
    expect(
      existsSync(
        join(
          hermesHome,
          "writing-templates",
          "weekly-report-123",
          "weekly-report.docx",
        ),
      ),
    ).toBe(true);
    expect(
      readFileSync(
        join(
          hermesHome,
          "skills",
          "custom",
          "finance",
          "agents",
          "openai.yaml",
        ),
        "utf8",
      ),
    ).toBe("nested skill asset");

    expect(installPackagedPresetContent(presetRoot, hermesHome)).toEqual({
      skillsCopied: 0,
      templatesCopied: 0,
    });
  });
});
