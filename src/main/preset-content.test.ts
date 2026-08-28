import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installManagedUserSkills,
  installPackagedPresetContent,
  quarantineLegacyMarketReportSkill,
} from "./preset-content";

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

  it("copies skills and templates once without replacing user-owned entries", async () => {
    // @lat: [[main-process#Packaged preset user content]]
    writeFixture(
      join(presetRoot, "skills", "custom", "recruiting", "SKILL.md"),
      "preset skill",
    );
    writeFixture(
      join(presetRoot, "skills", "custom", "finance", "agents", "openai.yaml"),
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

    const first = await installPackagedPresetContent(presetRoot, hermesHome);

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

    await expect(
      installPackagedPresetContent(presetRoot, hermesHome),
    ).resolves.toEqual({
      skillsCopied: 0,
      templatesCopied: 0,
    });
  });

  it("copies binary templates whose directories and files use Chinese names", async () => {
    const template = join(
      presetRoot,
      "writing-templates",
      "综合行政通用会议纪要模板-标准版",
      "综合行政通用会议纪要模板（标准版）.docx",
    );
    const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
    mkdirSync(dirname(template), { recursive: true });
    writeFileSync(template, binary);
    writeFixture(
      join(dirname(template), "metadata.json"),
      JSON.stringify({ name: "综合行政通用会议纪要模板" }),
    );

    await expect(
      installPackagedPresetContent(presetRoot, hermesHome),
    ).resolves.toEqual({ skillsCopied: 0, templatesCopied: 1 });
    expect(
      readFileSync(
        join(
          hermesHome,
          "writing-templates",
          "综合行政通用会议纪要模板-标准版",
          "综合行政通用会议纪要模板（标准版）.docx",
        ),
      ),
    ).toEqual(binary);
  });

  it("moves the obsolete research report Skill outside discovery roots", async () => {
    // @lat: [[discover#Legacy report Skill migration]]
    const canonical = join(
      hermesHome,
      "skills",
      "custom",
      "market-report-rag",
      "SKILL.md",
    );
    const legacy = join(
      hermesHome,
      "skills",
      "research",
      "market-report-rag",
      "SKILL.md",
    );
    writeFixture(canonical, "canonical custom report");
    writeFixture(legacy, "legacy report with possible local edits");

    const backup = await quarantineLegacyMarketReportSkill(hermesHome);

    expect(backup).not.toBeNull();
    expect(
      existsSync(join(hermesHome, "skills", "research", "market-report-rag")),
    ).toBe(false);
    expect(readFileSync(canonical, "utf8")).toBe("canonical custom report");
    expect(readFileSync(join(backup!, "SKILL.md"), "utf8")).toBe(
      "legacy report with possible local edits",
    );
  });

  it("refreshes maintained user Skills and backs up previous content", async () => {
    // @lat: [[discover#Managed user Skill upgrades]]
    const managedNames = [
      "market-report-rag",
      "hr-analysis-report-rag",
      "finance-analysis-report-rag",
      "skill-creator",
    ];
    for (const name of managedNames) {
      writeFixture(
        join(presetRoot, "skills", "custom", name, "SKILL.md"),
        `new-${name}`,
      );
      writeFixture(
        join(hermesHome, "skills", "custom", name, "SKILL.md"),
        `old-${name}`,
      );
    }

    await expect(
      installManagedUserSkills(presetRoot, hermesHome),
    ).resolves.toBe(4);

    for (const name of managedNames) {
      expect(
        readFileSync(
          join(hermesHome, "skills", "custom", name, "SKILL.md"),
          "utf8",
        ),
      ).toBe(`new-${name}`);
    }
    const backups = readdirSync(join(hermesHome, "skill-backups"));
    expect(
      managedNames.every((name) =>
        backups.some((entry) => entry.startsWith(`previous-custom-${name}-`)),
      ),
    ).toBe(true);

    await expect(
      installManagedUserSkills(presetRoot, hermesHome),
    ).resolves.toBe(0);
    expect(readdirSync(join(hermesHome, "skill-backups"))).toEqual(backups);
  });
});
