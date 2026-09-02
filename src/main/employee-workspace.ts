import { createHash, randomUUID } from "crypto";
import Database from "better-sqlite3";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "fs";
import { dirname, join } from "path";
import type {
  EmployeeIdentity,
  EmployeeProfileBinding,
  EmployeeRoleBinding,
} from "../shared/employee-workspace";
import { HERMES_HOME } from "./installer";
import { profileHome, safeWriteFile } from "./utils";

const BINDING_FILE = "employee-binding.json";
const PENDING_BINDING_FILE = "employee-binding.pending.json";
const FAILED_BINDING_FILE = "employee-binding.failed.json";
const LEGACY_MIGRATION_FILE = "employee-default-migration.json";
const SOUL_TEMPLATE_VERSION = 1;
const ROLE_CATALOG_VERSION = 1;
const MANAGED_SOUL_START = "<!-- JINGYU_EMPLOYEE_IDENTITY_START -->";
const MANAGED_SOUL_END = "<!-- JINGYU_EMPLOYEE_IDENTITY_END -->";

interface LegacyMigrationMarker {
  schemaVersion: 1;
  state: "pending" | "complete";
  userId: string;
  profileId: string;
  updatedAt: number;
}

export interface LegacyEmployeeMigrationPlan {
  profileId: string;
  userId: string;
  shouldMigrate: boolean;
  pending: boolean;
}

interface EmployeeLookupPayload {
  user_id?: unknown;
  username?: unknown;
  real_name?: unknown;
  phone?: unknown;
  email?: unknown;
  department?: unknown;
  department_name?: unknown;
  position?: unknown;
  role?: unknown;
  job_title?: unknown;
  jobTitle?: unknown;
}

interface RoleDefinition {
  id: string;
  name: string;
  aliases: string[];
  mandatorySkills: string[];
}

const ROLE_CATALOG: RoleDefinition[] = [
  {
    id: "project-manager",
    name: "项目经理",
    aliases: ["项目经理", "project manager", "project-manager"],
    mandatorySkills: ["project-manager"],
  },
];

function scalar(value: unknown, maxLength = 200): string {
  return typeof value === "string"
    ? value
        .replace(/[\0\r\n]+/g, " ")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeRoleAlias(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, "");
}

export function parseEmployeeIdentity(
  payload: EmployeeLookupPayload,
  requestedPhone: string,
): EmployeeIdentity {
  const userId = scalar(payload.user_id, 128);
  if (!userId) throw new Error("查询结果未包含稳定的员工 user_id。");

  const responsePhone = scalar(payload.phone, 32).replace(/\s|-/g, "");
  const phone = responsePhone || requestedPhone;
  if (phone !== requestedPhone) {
    throw new Error("员工查询结果与输入手机号不一致，请重新确认。");
  }

  return {
    userId,
    username: scalar(payload.username, 128),
    realName: scalar(payload.real_name, 80),
    phone,
    email: scalar(payload.email, 254),
  };
}

/**
 * Compatibility seam for the future personnel response. Current responses do
 * not contain a position; accepting common field names here keeps the rest of
 * profile provisioning unchanged when the API is extended.
 */
export function resolveEmployeeRole(
  payload: EmployeeLookupPayload,
): EmployeeRoleBinding {
  const department = scalar(payload.department_name ?? payload.department, 120);
  const position = scalar(
    payload.position ?? payload.job_title ?? payload.jobTitle ?? payload.role,
    120,
  );
  if (!position) {
    return {
      status: "awaiting_position",
      department,
      position: "",
      roleId: null,
      roleName: null,
      mandatorySkills: [],
    };
  }

  const normalized = normalizeRoleAlias(position);
  const definition = ROLE_CATALOG.find((entry) =>
    entry.aliases.some((alias) => normalizeRoleAlias(alias) === normalized),
  );
  if (!definition) {
    return {
      status: "unmapped",
      department,
      position,
      roleId: null,
      roleName: null,
      mandatorySkills: [],
    };
  }
  return {
    status: "configured",
    department,
    position,
    roleId: definition.id,
    roleName: definition.name,
    mandatorySkills: [...definition.mandatorySkills],
  };
}

export function employeeProfileIdForUserId(userId: string): string {
  const normalized = userId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(userId).digest("hex").slice(0, 8);
  const prefix = normalized.slice(0, 44) || "user";
  return `employee-${prefix}-${digest}`;
}

function bindingPath(profile: string): string {
  return join(profileHome(profile), BINDING_FILE);
}

function pendingBindingPath(profile: string): string {
  return join(profileHome(profile), PENDING_BINDING_FILE);
}

function failedBindingPath(profile: string): string {
  return join(profileHome(profile), FAILED_BINDING_FILE);
}

function legacyMigrationPath(): string {
  return join(HERMES_HOME, LEGACY_MIGRATION_FILE);
}

function readLegacyMigrationMarker(): LegacyMigrationMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(legacyMigrationPath(), "utf8"),
    ) as Partial<LegacyMigrationMarker>;
    if (
      parsed.schemaVersion !== 1 ||
      (parsed.state !== "pending" && parsed.state !== "complete") ||
      typeof parsed.userId !== "string" ||
      typeof parsed.profileId !== "string"
    ) {
      return null;
    }
    return parsed as LegacyMigrationMarker;
  } catch {
    return null;
  }
}

function directoryHasFiles(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path, { withFileTypes: true }).some((entry) =>
      entry.isFile()
        ? true
        : entry.isDirectory() && directoryHasFiles(join(path, entry.name)),
    );
  } catch {
    return true;
  }
}

function stateDbHasSessions(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as
        | { count?: number }
        | undefined;
      return Number(row?.count || 0) > 0;
    } finally {
      db.close();
    }
  } catch {
    // An unreadable existing DB is user data. Fail closed instead of replacing
    // it as though it were an empty freshly-created store.
    return true;
  }
}

interface StateDatabaseHistorySignature {
  sessionIds: string[];
  messageCount: number;
}

function stateDatabaseHistorySignature(
  path: string,
): StateDatabaseHistorySignature {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      sessionIds: (
        db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{
          id: string;
        }>
      ).map((row) => row.id),
      messageCount: Number(
        (
          db.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count?: number;
          }
        ).count || 0,
      ),
    };
  } finally {
    db.close();
  }
}

function stateDatabasePublicationStatus(
  sourcePath: string,
  targetPath: string,
): "empty" | "published" | "conflict" {
  if (!existsSync(targetPath)) return "empty";
  try {
    const target = stateDatabaseHistorySignature(targetPath);
    if (target.sessionIds.length === 0) return "empty";
    const source = stateDatabaseHistorySignature(sourcePath);
    return target.messageCount === source.messageCount &&
      target.sessionIds.length === source.sessionIds.length &&
      target.sessionIds.every((id, index) => id === source.sessionIds[index])
      ? "published"
      : "conflict";
  } catch (error) {
    throw new Error(
      `员工历史数据库状态无法确认，已停止迁移：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function writeLegacyMigrationMarker(
  state: LegacyMigrationMarker["state"],
  userId: string,
  profileId: string,
): void {
  safeWriteFile(
    legacyMigrationPath(),
    JSON.stringify(
      { schemaVersion: 1, state, userId, profileId, updatedAt: Date.now() },
      null,
      2,
    ),
  );
}

export function planLegacyEmployeeMigration(
  profileId: string,
  userId: string,
): LegacyEmployeeMigrationPlan {
  const marker = readLegacyMigrationMarker();
  if (marker) {
    const sameOwner =
      marker.userId === userId && marker.profileId === profileId;
    return {
      profileId,
      userId,
      shouldMigrate: sameOwner && marker.state === "pending",
      pending: sameOwner && marker.state === "pending",
    };
  }

  if (profileId === "default") {
    return { profileId, userId, shouldMigrate: false, pending: false };
  }

  const sourceHasHistory =
    stateDbHasSessions(join(profileHome("default"), "state.db")) ||
    directoryHasFiles(join(profileHome("default"), "sessions"));
  const targetHasHistory =
    stateDbHasSessions(join(profileHome(profileId), "state.db")) ||
    directoryHasFiles(join(profileHome(profileId), "sessions"));
  return {
    profileId,
    userId,
    shouldMigrate: sourceHasHistory && !targetHasHistory,
    pending: false,
  };
}

async function publishStateDatabase(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  if (!existsSync(sourcePath)) return;
  const publicationStatus = stateDatabasePublicationStatus(
    sourcePath,
    targetPath,
  );
  if (publicationStatus === "published") return;
  if (publicationStatus === "conflict") {
    throw new Error(
      "员工工作区已产生不同的聊天记录，不能自动迁移默认工作区历史。",
    );
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const token = randomUUID();
  const stagedPath = `${targetPath}.employee-migration-${token}.tmp`;
  const previousPath = `${targetPath}.employee-migration-${token}.previous`;
  const source = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  const expectedSessions = Number(
    (
      source.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
        count?: number;
      }
    ).count || 0,
  );
  const expectedMessages = Number(
    (
      source.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
        count?: number;
      }
    ).count || 0,
  );
  try {
    await source.backup(stagedPath);
  } finally {
    source.close();
  }

  try {
    const staged = new Database(stagedPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const integrity = staged.pragma("integrity_check", { simple: true });
      const sessions = Number(
        (
          staged.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
            count?: number;
          }
        ).count || 0,
      );
      const messages = Number(
        (
          staged.prepare("SELECT COUNT(*) AS count FROM messages").get() as {
            count?: number;
          }
        ).count || 0,
      );
      if (
        integrity !== "ok" ||
        sessions !== expectedSessions ||
        messages !== expectedMessages
      ) {
        throw new Error("员工历史数据库备份校验失败，未发布迁移结果。");
      }
    } finally {
      staged.close();
    }
  } catch (error) {
    rmSync(stagedPath, { force: true });
    throw error;
  }

  let previousSaved = false;
  try {
    rmSync(`${targetPath}-wal`, { force: true });
    rmSync(`${targetPath}-shm`, { force: true });
    if (existsSync(targetPath)) {
      renameSync(targetPath, previousPath);
      previousSaved = true;
    }
    renameSync(stagedPath, targetPath);
    if (previousSaved) rmSync(previousPath, { force: true });
  } catch (error) {
    rmSync(stagedPath, { force: true });
    if (previousSaved && !existsSync(targetPath)) {
      renameSync(previousPath, targetPath);
    }
    throw error;
  }
}

function copyDirectoryWhenTargetEmpty(source: string, target: string): void {
  if (!directoryHasFiles(source) || directoryHasFiles(target)) return;
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, force: false });
}

/**
 * Prepare continuity files for the one legacy default workspace that predates
 * employee Profiles. The source is copied, never removed, and the pending
 * marker makes an interrupted migration safely resumable.
 */
export async function prepareLegacyEmployeeMigration(
  plan: LegacyEmployeeMigrationPlan,
): Promise<boolean> {
  if (!plan.shouldMigrate) return false;
  const marker = readLegacyMigrationMarker();
  if (
    marker &&
    (marker.userId !== plan.userId || marker.profileId !== plan.profileId)
  ) {
    return false;
  }

  writeLegacyMigrationMarker("pending", plan.userId, plan.profileId);
  const sourceHome = profileHome("default");
  const targetHome = profileHome(plan.profileId);
  mkdirSync(targetHome, { recursive: true });
  await publishStateDatabase(
    join(sourceHome, "state.db"),
    join(targetHome, "state.db"),
  );
  copyDirectoryWhenTargetEmpty(
    join(sourceHome, "sessions"),
    join(targetHome, "sessions"),
  );
  // Writing templates are user assets rather than runtime identity. Merge
  // missing files only so employee-specific edits always win.
  const sourceTemplates = join(sourceHome, "writing-templates");
  if (directoryHasFiles(sourceTemplates)) {
    cpSync(sourceTemplates, join(targetHome, "writing-templates"), {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
  return true;
}

export function completeLegacyEmployeeMigration(
  profileId: string,
  userId: string,
): void {
  const marker = readLegacyMigrationMarker();
  if (
    marker?.state === "pending" &&
    marker.userId === userId &&
    marker.profileId === profileId
  ) {
    writeLegacyMigrationMarker("complete", userId, profileId);
  }
}

function bindingEmployeeId(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      employee?: { userId?: unknown };
    };
    return typeof parsed.employee?.userId === "string"
      ? parsed.employee.userId
      : null;
  } catch {
    return null;
  }
}

function profileBelongsToEmployee(profile: string, userId: string): boolean {
  return [
    bindingPath(profile),
    pendingBindingPath(profile),
    failedBindingPath(profile),
  ].some((path) => bindingEmployeeId(path) === userId);
}

export function readEmployeeProfileBinding(
  profile?: string,
): EmployeeProfileBinding | null {
  try {
    const parsed = JSON.parse(
      readFileSync(bindingPath(profile || "default"), "utf8"),
    ) as Partial<EmployeeProfileBinding>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.provisionState !== "ready" ||
      !parsed.employee ||
      typeof parsed.employee.userId !== "string" ||
      !parsed.role ||
      !Array.isArray(parsed.role.mandatorySkills)
    ) {
      return null;
    }
    return parsed as EmployeeProfileBinding;
  } catch {
    return null;
  }
}

export function findEmployeeProfile(userId: string): string | null {
  if (profileBelongsToEmployee("default", userId)) {
    return "default";
  }
  const profilesRoot = join(HERMES_HOME, "profiles");
  if (!existsSync(profilesRoot)) return null;
  try {
    for (const entry of readdirSync(profilesRoot)) {
      const directory = join(profilesRoot, entry);
      if (!statSync(directory).isDirectory()) continue;
      if (profileBelongsToEmployee(entry, userId)) {
        return entry;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function employeeProfileIdAvailable(
  profile: string,
  userId: string,
): boolean {
  if (!existsSync(profileHome(profile))) return true;
  return profileBelongsToEmployee(profile, userId);
}

export function createEmployeeProfileBinding(
  employee: EmployeeIdentity,
  role: EmployeeRoleBinding,
): EmployeeProfileBinding {
  return {
    schemaVersion: 1,
    provisionState: "ready",
    employee,
    role,
    soulTemplateVersion: SOUL_TEMPLATE_VERSION,
    roleCatalogVersion: ROLE_CATALOG_VERSION,
    updatedAt: Date.now(),
  };
}

export function beginEmployeeProvision(
  profile: string,
  binding: EmployeeProfileBinding,
): void {
  rmSync(failedBindingPath(profile), { force: true });
  safeWriteFile(
    pendingBindingPath(profile),
    JSON.stringify({ ...binding, provisionState: "initializing" }, null, 2),
  );
}

export function commitEmployeeProvision(
  profile: string,
  binding: EmployeeProfileBinding,
): void {
  safeWriteFile(bindingPath(profile), JSON.stringify(binding, null, 2));
  rmSync(pendingBindingPath(profile), { force: true });
  rmSync(failedBindingPath(profile), { force: true });
}

export function abortEmployeeProvision(profile: string, error?: unknown): void {
  try {
    const pending = JSON.parse(
      readFileSync(pendingBindingPath(profile), "utf8"),
    ) as Record<string, unknown>;
    const message =
      error instanceof Error ? error.message : "员工工作区初始化失败。";
    safeWriteFile(
      failedBindingPath(profile),
      JSON.stringify(
        {
          ...pending,
          provisionState: "failed",
          error: message.slice(0, 500),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
    );
  } catch {
    // The original provisioning error remains authoritative.
  }
  rmSync(pendingBindingPath(profile), { force: true });
}

const TRANSACTION_FILES = [
  ".env",
  "config.yaml",
  "SOUL.md",
  "employee-model-access.json",
  "profile-meta.json",
  BINDING_FILE,
] as const;

export interface EmployeeProfileSnapshot {
  files: Array<{ name: string; content: string | null }>;
}

export function snapshotEmployeeProfile(
  profile: string,
): EmployeeProfileSnapshot {
  return {
    files: TRANSACTION_FILES.map((name) => {
      const path = join(profileHome(profile), name);
      return {
        name,
        content: existsSync(path) ? readFileSync(path, "utf8") : null,
      };
    }),
  };
}

export function restoreEmployeeProfile(
  profile: string,
  snapshot: EmployeeProfileSnapshot,
): void {
  for (const file of snapshot.files) {
    const path = join(profileHome(profile), file.name);
    if (file.content === null) {
      rmSync(path, { force: true });
    } else {
      safeWriteFile(path, file.content);
    }
  }
}

function renderManagedSoul(binding: EmployeeProfileBinding): string {
  const { employee, role } = binding;
  const employeeName = employee.realName || employee.username || "未命名员工";
  const roleText =
    role.status === "configured"
      ? `当前岗位为“${role.roleName}”（接口原值：${role.position}）。处理岗位工作时，必须加载并遵循这些岗位 Skill：${role.mandatorySkills.join(", ")}。`
      : role.status === "unmapped"
        ? `接口返回岗位“${role.position}”，但本地尚未配置对应岗位能力。不得自行猜测工作流程或岗位权限。`
        : "当前人员接口尚未返回岗位信息。不得根据姓名、部门、问题内容或历史对话猜测岗位。";

  return `${MANAGED_SOUL_START}
## 员工数字身份

你是为员工“${employeeName}”配置的数字员工工作空间，不得冒充员工本人，也不得声称拥有现实中的审批、承诺、签署或决策权限。

- 员工姓名：${employeeName}
- 员工账号：${employee.username || "未提供"}
- 员工标识：${employee.userId}
- 部门：${role.department || "接口暂未提供"}
- 岗位：${role.position || "接口暂未提供"}

${roleText}

岗位信息缺失或未映射时，可以完成通用协助，但涉及岗位专属流程、权限或口径时必须明确说明尚未配置，并向用户确认所需工作背景。
${MANAGED_SOUL_END}`;
}

export function mergeEmployeeSoul(
  existingSoul: string,
  binding: EmployeeProfileBinding,
): string {
  const managed = renderManagedSoul(binding);
  const start = existingSoul.indexOf(MANAGED_SOUL_START);
  const end = existingSoul.indexOf(MANAGED_SOUL_END);
  if (start >= 0 && end >= start) {
    return `${existingSoul.slice(0, start)}${managed}${existingSoul.slice(end + MANAGED_SOUL_END.length)}`;
  }
  const trimmed = existingSoul.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${managed}\n`;
}
