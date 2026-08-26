import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  home: `${process.env.TEMP || "C:\\tmp"}\\hermes-desktop-skills-${process.pid}`,
}));

vi.mock("./installer", () => ({
  HERMES_HOME: mocks.home,
  HERMES_PYTHON: "python",
  HERMES_REPO: `${mocks.home}\\hermes-agent`,
  hermesCliArgs: (args: string[]) => args,
  getEnhancedPath: () => "",
}));

vi.mock("./utils", () => ({
  isValidNamedProfileName: () => true,
  profileHome: (profile?: string) =>
    profile && profile !== "default"
      ? `${mocks.home}\\profiles\\${profile}`
      : mocks.home,
}));

import {
  ensureLegacyUserSkillMarkers,
  ensureStarterUserSkills,
  listUserAddedSkills,
} from "./skills";

describe("starter user skills", () => {
  beforeEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  it("provisions editable skills including RAG without overwriting user changes", () => {
    // @lat: [[discover#Starter user skills]]
    const skills = listUserAddedSkills();

    expect(skills.map((skill) => skill.name)).toEqual([
      "finance",
      "hr",
      "market-report-rag",
      "project-manager",
      "skill-creator",
    ]);
    expect(skills.every((skill) => skill.category === "custom")).toBe(true);
    expect(
      skills.every((skill) =>
        existsSync(join(skill.path, ".hermes-desktop-user-added")),
      ),
    ).toBe(true);

    const hrFile = join(mocks.home, "skills", "custom", "hr", "SKILL.md");
    writeFileSync(hrFile, "user-owned content", "utf-8");
    ensureStarterUserSkills();
    expect(readFileSync(hrFile, "utf-8")).toBe("user-owned content");
  });

  it("exposes the packaged RAG Skill in each profile's user picker and preserves edits", () => {
    // @lat: [[discover#Market report user Skill]]
    for (const profile of [undefined, "employee-test"]) {
      const rag = listUserAddedSkills(profile).find(
        (skill) => skill.name === "market-report-rag",
      );
      expect(rag?.category).toBe("custom");
      expect(existsSync(join(rag!.path, "scripts", "rag_client.py"))).toBe(
        true,
      );
      expect(
        existsSync(join(rag!.path, "references", "report-workflow.md")),
      ).toBe(true);
      const skillFile = join(rag!.path, "SKILL.md");
      writeFileSync(skillFile, "User customized report instructions", "utf8");
      ensureStarterUserSkills(profile);
      expect(readFileSync(skillFile, "utf8")).toBe(
        "User customized report instructions",
      );
    }
  });

  it("gates legacy profile skills that are absent from the bundled runtime", () => {
    // @lat: [[chat-commands#Slash command execution#Session Skill activation]]
    const localResearch = join(mocks.home, "skills", "research");
    const bundledResearch = join(
      mocks.home,
      "hermes-agent",
      "skills",
      "research",
    );
    const legacy = join(localResearch, "internal-milvus-data");
    const system = join(localResearch, "market-report-rag");
    mkdirSync(legacy, { recursive: true });
    mkdirSync(system, { recursive: true });
    mkdirSync(join(bundledResearch, "market-report-rag"), { recursive: true });
    writeFileSync(
      join(legacy, "SKILL.md"),
      "---\nname: internal-milvus-data\ndescription: legacy\n---\n",
      "utf8",
    );
    for (const path of [
      join(system, "SKILL.md"),
      join(bundledResearch, "market-report-rag", "SKILL.md"),
    ]) {
      writeFileSync(
        path,
        "---\nname: market-report-rag\ndescription: system\n---\n",
        "utf8",
      );
    }

    ensureLegacyUserSkillMarkers();

    expect(existsSync(join(legacy, ".hermes-desktop-user-added"))).toBe(true);
    expect(existsSync(join(system, ".hermes-desktop-user-added"))).toBe(false);
    expect(listUserAddedSkills().map((skill) => skill.name)).toContain(
      "internal-milvus-data",
    );
  });

  it("does not infer legacy skill ownership before the bundled inventory exists", () => {
    const localSkill = join(
      mocks.home,
      "skills",
      "research",
      "market-report-rag",
    );
    mkdirSync(localSkill, { recursive: true });
    writeFileSync(
      join(localSkill, "SKILL.md"),
      "---\nname: market-report-rag\ndescription: local copy\n---\n",
      "utf8",
    );

    ensureLegacyUserSkillMarkers();

    expect(existsSync(join(localSkill, ".hermes-desktop-user-added"))).toBe(
      false,
    );
  });
});
