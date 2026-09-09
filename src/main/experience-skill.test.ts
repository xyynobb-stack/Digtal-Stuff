// @vitest-environment node
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { emptyScenario, SCENARIO_FIELDS } from "../shared/experience-skill";
const state = vi.hoisted(() => ({
  home: "",
  active: "employee-a",
  mode: "local",
  name: "向永驿",
  onMeta: () => {},
}));
vi.mock("./utils", () => ({
  profileHome: (p: string) => join(state.home, p),
  getActiveProfileNameSync: () => state.active,
  isValidProfileName: (p: string) => /^[a-z-]+$/.test(p),
}));
vi.mock("./config", () => ({
  getConnectionConfig: () => ({ mode: state.mode }),
}));
vi.mock("./profile-meta", () => ({
  readProfileMeta: async () => {
    state.onMeta();
    return { name: state.name };
  },
}));
import {
  loadExperience,
  previewExperience,
  publishExperience,
} from "./experience-skill";
function template() {
  const scene = emptyScenario();
  for (const [key] of SCENARIO_FIELDS) scene[key] = key;
  return { role: "项目经理", scope: "团队", scenarios: [scene] };
}
describe("personal skill publication", () => {
  beforeEach(() => {
    state.home = mkdtempSync(join(tmpdir(), "experience-test-"));
    state.active = "employee-a";
    state.mode = "local";
    state.name = "向永驿";
    state.onMeta = () => {};
  });
  afterEach(() => {
    rmSync(state.home, { recursive: true, force: true });
  });
  it("previews without installation, publishes with sources and backs up updates", async () => {
    const first = await previewExperience("employee-a", template(), "");
    const path = join(
      state.home,
      "employee-a",
      "skills/custom/personal-experience/SKILL.md",
    );
    expect(existsSync(path)).toBe(false);
    const saved = await publishExperience("employee-a", first.token);
    expect(readFileSync(path, "utf8")).toBe(first.markdown);
    expect((await loadExperience("employee-a")).template).toEqual(template());
    const second = await previewExperience(
      "employee-a",
      { ...template(), role: "技术经理" },
      saved.revision,
    );
    await publishExperience("employee-a", second.token);
    expect(
      readdirSync(join(state.home, "employee-a", "experience-skill-sources")),
    ).toContain(`${saved.revision}.md`);
    expect(existsSync(join(state.home, "employee-b"))).toBe(false);
  });
  it("rejects profile changes during async identity resolution", async () => {
    state.onMeta = () => {
      state.active = "employee-b";
    };
    await expect(
      previewExperience("employee-a", template(), ""),
    ).rejects.toThrow("账号已切换");
    expect(existsSync(join(state.home, "employee-a"))).toBe(false);
  });
  it("rejects stale previews, changed identity and remote mode", async () => {
    const first = await previewExperience("employee-a", template(), "");
    const second = await previewExperience("employee-a", template(), "");
    await expect(publishExperience("employee-a", first.token)).rejects.toThrow(
      "预览已失效",
    );
    state.name = "陈杰";
    await expect(publishExperience("employee-a", second.token)).rejects.toThrow(
      "用户名已更新",
    );
    state.mode = "ssh";
    await expect(loadExperience("employee-a")).rejects.toThrow("本地模式");
  });
  it("never overwrites an external modification after preview", async () => {
    const first = await previewExperience("employee-a", template(), "");
    const saved = await publishExperience("employee-a", first.token);
    const next = await previewExperience(
      "employee-a",
      template(),
      saved.revision,
    );
    const path = join(
      state.home,
      "employee-a",
      "skills/custom/personal-experience/SKILL.md",
    );
    writeFileSync(path, "external modification");
    await expect(publishExperience("employee-a", next.token)).rejects.toThrow(
      "技能已被修改",
    );
    expect(readFileSync(path, "utf8")).toBe("external modification");
  });
});
