import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
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

import { ensureStarterUserSkills, listUserAddedSkills } from "./skills";

describe("starter user skills", () => {
  beforeEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(mocks.home, { recursive: true, force: true });
  });

  it("provisions the four editable skills without overwriting user changes", () => {
    // @lat: [[discover#Starter user skills]]
    const skills = listUserAddedSkills();

    expect(skills.map((skill) => skill.name)).toEqual([
      "finance",
      "hr",
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
});
