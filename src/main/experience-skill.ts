import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import {
  getActiveProfileNameSync,
  isValidProfileName,
  profileHome,
} from "./utils";
import { getConnectionConfig } from "./config";
import { readProfileMeta } from "./profile-meta";
import {
  compileExperience,
  emptyExperience,
  validateExperience,
} from "../shared/experience-skill";
import type {
  ExperiencePreview,
  ExperienceState,
  ExperienceTemplate,
} from "../shared/experience-skill";

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const previews = new Map<
  string,
  {
    profile: string;
    displayName: string;
    template: ExperienceTemplate;
    markdown: string;
    revision: string;
    expires: number;
  }
>();
function assertProfile(profile: string): void {
  if (!isValidProfileName(profile) || profile !== getActiveProfileNameSync())
    throw new Error("当前账号已切换，请返回功能区重新打开后操作");
  if (getConnectionConfig().mode !== "local")
    throw new Error("岗位经验沉淀目前仅支持本地模式");
}
function skillPath(profile: string): string {
  return join(
    profileHome(profile),
    "skills",
    "custom",
    "personal-experience",
    "SKILL.md",
  );
}
function revision(profile: string): string {
  const file = skillPath(profile);
  return existsSync(file) ? hash(readFileSync(file, "utf8")) : "";
}
function sourceDir(profile: string): string {
  return join(profileHome(profile), "experience-skill-sources");
}
function atomicWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export async function loadExperience(
  profile: string,
): Promise<ExperienceState> {
  assertProfile(profile);
  const meta = await readProfileMeta(profile);
  assertProfile(profile);
  if (!meta.name?.trim())
    throw new Error("请先在左下角账号设置中填写用户名，再创建个人 SKILL");
  if (meta.name.length > 74 || /[\r\n"'\\]/.test(meta.name))
    throw new Error("用户名过长或含不支持的符号，请先在账号设置中调整");
  const rev = revision(profile);
  let template = emptyExperience();
  if (rev) {
    const source = join(sourceDir(profile), `${rev}.json`);
    if (!existsSync(source))
      throw new Error(
        "同名技能不是由此功能生成，或来源快照丢失；为防止覆盖，请先在技能管理中检查",
      );
    template = validateExperience(JSON.parse(readFileSync(source, "utf8")));
  }
  return { displayName: meta.name || profile, template, revision: rev };
}
export async function previewExperience(
  profile: string,
  input: unknown,
  expectedRevision: string,
): Promise<ExperiencePreview> {
  const template = validateExperience(input);
  const state = await loadExperience(profile);
  if (state.revision !== expectedRevision)
    throw new Error("技能已被其他窗口修改，请重新打开后再生成");
  const markdown = compileExperience(template, state.displayName);
  for (const [key, value] of previews)
    if (value.expires < Date.now() || value.profile === profile)
      previews.delete(key);
  if (previews.size >= 20) throw new Error("待确认预览过多，请稍后重试");
  const token = randomUUID();
  previews.set(token, {
    profile,
    displayName: state.displayName,
    template,
    markdown,
    revision: state.revision,
    expires: Date.now() + 30 * 60_000,
  });
  return {
    markdown,
    token,
    displayName: `${state.displayName}的SKILL`,
    replacing: !!state.revision,
  };
}
export async function publishExperience(
  profile: string,
  token: string,
): Promise<{ revision: string }> {
  assertProfile(profile);
  const pending = previews.get(token);
  if (!pending || pending.profile !== profile || pending.expires < Date.now())
    throw new Error("预览已失效，请重新生成并确认");
  const meta = await readProfileMeta(profile);
  // No awaits after this guard: publication is a bounded synchronous transaction.
  assertProfile(profile);
  if ((meta.name || profile) !== pending.displayName)
    throw new Error("用户名已更新，请重新生成预览");
  if (revision(profile) !== pending.revision)
    throw new Error("技能已被修改，请重新打开后再保存");
  const next = hash(pending.markdown);
  mkdirSync(sourceDir(profile), { recursive: true });
  // Publish the source snapshot first. An interrupted write never replaces the old skill.
  atomicWrite(
    join(sourceDir(profile), `${next}.json`),
    JSON.stringify(pending.template, null, 2),
  );
  const directory = join(
    profileHome(profile),
    "skills",
    "custom",
    "personal-experience",
  );
  mkdirSync(directory, { recursive: true });
  if (pending.revision) {
    atomicWrite(
      join(sourceDir(profile), `${pending.revision}.md`),
      readFileSync(skillPath(profile), "utf8"),
    );
  }
  atomicWrite(skillPath(profile), pending.markdown);
  previews.delete(token);
  return { revision: next };
}
