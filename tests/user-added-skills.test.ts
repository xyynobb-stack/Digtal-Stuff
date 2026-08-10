import { describe, expect, it, vi } from "vitest";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

const { TEST_HOME, TEST_REPO } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("os");
  const home = path.join(os.tmpdir(), `hermes-user-skills-${Date.now()}`);
  return { TEST_HOME: home, TEST_REPO: path.join(home, "hermes-agent") };
});

vi.mock("../src/main/installer", () => ({
  HERMES_HOME: TEST_HOME,
  HERMES_REPO: TEST_REPO,
  HERMES_PYTHON: "python",
  hermesCliArgs: (args: string[] = []) => args,
  getEnhancedPath: () => "",
}));

import { importLocalSkill, listUserAddedSkills } from "../src/main/skills";

function writeSkill(root: string, name: string, category: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "SKILL.md"),
    `---\nname: ${name}\ncategory: ${category}\ndescription: ${name} description\n---\n`,
    "utf-8",
  );
  return join(root, "SKILL.md");
}

describe("listUserAddedSkills", () => {
  it("excludes bundled skills and preserves an existing non-bundled custom skill", () => {
    writeSkill(
      join(TEST_REPO, "skills", "productivity", "bundled-notes"),
      "bundled-notes",
      "productivity",
    );
    writeSkill(
      join(TEST_HOME, "skills", "productivity", "bundled-notes"),
      "bundled-notes",
      "productivity",
    );
    writeSkill(
      join(TEST_HOME, "skills", "custom", "python-web-reader"),
      "python-web-reader",
      "custom",
    );
    writeSkill(
      join(TEST_HOME, "skills", "research", "system-research"),
      "system-research",
      "research",
    );

    expect(listUserAddedSkills().map((skill) => skill.name)).toEqual([
      "python-web-reader",
    ]);
  });

  it("always stores a local import under custom and includes it in the picker", () => {
    writeSkill(
      join(TEST_REPO, "skills", "research", "employee-research"),
      "employee-research",
      "research",
    );
    const source = writeSkill(
      join(TEST_HOME, "import-source", "employee-research"),
      "employee-research",
      "research",
    );

    expect(importLocalSkill(source)).toMatchObject({ success: true });
    expect(
      existsSync(
        join(TEST_HOME, "skills", "custom", "employee-research", "SKILL.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(TEST_HOME, "skills", "research", "employee-research", "SKILL.md"),
      ),
    ).toBe(false);
    expect(listUserAddedSkills().map((skill) => skill.name)).toContain(
      "employee-research",
    );
  });
});
