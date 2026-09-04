import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRoot = join(
  process.env.TEMP || "C:\\tmp",
  `hermes-employee-workspace-${process.pid}`,
);

vi.mock("./installer", () => ({
  HERMES_HOME: join(
    process.env.TEMP || "C:\\tmp",
    `hermes-employee-workspace-${process.pid}`,
  ),
}));

import {
  abortEmployeeProvision,
  beginEmployeeProvision,
  commitEmployeeProvision,
  createEmployeeProfileBinding,
  employeeProfileIdForUserId,
  completeLegacyEmployeeMigration,
  mergeEmployeeSoul,
  parseEmployeeIdentity,
  planLegacyEmployeeMigration,
  prepareLegacyEmployeeMigration,
  readEmployeeProfileBinding,
  resolveEmployeeRole,
} from "./employee-workspace";

describe("employee workspace", () => {
  beforeEach(() => rmSync(testRoot, { recursive: true, force: true }));
  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it("distinguishes missing binding from corrupt binding for the settings reader", () => {
    expect(readEmployeeProfileBinding("employee-test", true)).toBeNull();
    const directory = join(testRoot, "profiles", "employee-test");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "employee-binding.json"), "invalid json");
    expect(() => readEmployeeProfileBinding("employee-test", true)).toThrow();
    expect(readEmployeeProfileBinding("employee-test")).toBeNull();
  });

  it("accepts a lookup response without inventing a missing position", () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Positionless current response]]
    const payload = {
      user_id: "11111111-2222-4333-8444-555555555555",
      username: "employee-demo",
      real_name: "员工示例",
      phone: "13900000000",
      email: "employee@example.com",
    };

    expect(parseEmployeeIdentity(payload, "13900000000")).toEqual({
      userId: payload.user_id,
      username: "employee-demo",
      realName: "员工示例",
      phone: "13900000000",
      email: "employee@example.com",
    });
    expect(resolveEmployeeRole(payload)).toEqual({
      status: "awaiting_position",
      department: "",
      position: "",
      roleId: null,
      roleName: null,
      mandatorySkills: [],
    });
  });

  it("maps the current position field to the research and development Profile", () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Current R&D mapping]]
    const payload = {
      user_id: "952776f5-d469-4cf5-8c21-4a8f4368000c",
      username: "employee-rd",
      real_name: "研发测试员工",
      phone: "13900000000",
      email: "rd@example.com",
      department: "研发部",
      position: "研发",
    };

    const identity = parseEmployeeIdentity(payload, "13900000000");
    const role = resolveEmployeeRole(payload);
    const binding = createEmployeeProfileBinding(identity, role);
    const soul = mergeEmployeeSoul("保留的全局规则。\n", binding);

    expect(role).toEqual({
      status: "configured",
      department: "研发部",
      position: "研发",
      roleId: "research-development",
      roleName: "研发",
      mandatorySkills: ["research-development"],
    });
    expect(binding.roleCatalogVersion).toBe(2);
    expect(soul).toContain("当前岗位为“研发”（接口原值：研发）");
    expect(soul).toContain("research-development");
  });

  it("does not infer a role from department when position is missing", () => {
    expect(resolveEmployeeRole({ department: "研发部" })).toEqual({
      status: "awaiting_position",
      department: "研发部",
      position: "",
      roleId: null,
      roleName: null,
      mandatorySkills: [],
    });
  });

  it("maps a future project-manager position to its mandatory Skill", () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Future project-manager mapping]]
    expect(
      resolveEmployeeRole({ department_name: "项目部", job_title: "项目经理" }),
    ).toEqual({
      status: "configured",
      department: "项目部",
      position: "项目经理",
      roleId: "project-manager",
      roleName: "项目经理",
      mandatorySkills: ["project-manager"],
    });
  });

  it("rejects a lookup response for another phone", () => {
    expect(() =>
      parseEmployeeIdentity(
        { user_id: "employee-1", phone: "13800000000" },
        "13900000000",
      ),
    ).toThrow("手机号不一致");
  });

  it("keeps a stable CLI-safe profile id", () => {
    expect(
      employeeProfileIdForUserId("11111111-2222-4333-8444-555555555555"),
    ).toMatch(/^employee-11111111-2222-4333-8444-555555555555-[a-f0-9]{8}$/);
  });

  it("preserves the existing SOUL outside the managed employee block", () => {
    const binding = createEmployeeProfileBinding(
      {
        userId: "employee-1",
        username: "worker",
        realName: "员工甲",
        phone: "13900000000",
        email: "",
      },
      resolveEmployeeRole({}),
    );
    const first = mergeEmployeeSoul("保留的全局规则。\n", binding);
    const second = mergeEmployeeSoul(`${first}\n人工补充。\n`, binding);

    expect(second).toContain("保留的全局规则。");
    expect(second).toContain("人工补充。");
    expect(second.match(/JINGYU_EMPLOYEE_IDENTITY_START/g)).toHaveLength(1);
    expect(second).toContain("不得根据姓名、部门、问题内容或历史对话猜测岗位");
  });

  it("exposes only a committed ready binding", () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Ready publication]]
    const profile = "employee-test";
    const binding = createEmployeeProfileBinding(
      {
        userId: "employee-test",
        username: "worker",
        realName: "员工乙",
        phone: "13700000000",
        email: "",
      },
      resolveEmployeeRole({}),
    );

    beginEmployeeProvision(profile, binding);
    expect(readEmployeeProfileBinding(profile)).toBeNull();
    expect(
      existsSync(
        join(testRoot, "profiles", profile, "employee-binding.pending.json"),
      ),
    ).toBe(true);

    commitEmployeeProvision(profile, binding);
    expect(readEmployeeProfileBinding(profile)?.employee.userId).toBe(
      "employee-test",
    );
    expect(
      existsSync(
        join(testRoot, "profiles", profile, "employee-binding.pending.json"),
      ),
    ).toBe(false);

    mkdirSync(join(testRoot, "profiles", profile), { recursive: true });
    writeFileSync(
      join(testRoot, "profiles", profile, "employee-binding.pending.json"),
      "pending",
    );
    abortEmployeeProvision(profile);
    expect(
      readFileSync(
        join(testRoot, "profiles", profile, "employee-binding.json"),
        "utf8",
      ),
    ).toContain('"provisionState": "ready"');
  });

  it("claims and resumes the legacy default workspace only once", async () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Legacy default continuity#One-time claim]]
    mkdirSync(join(testRoot, "sessions", "session-1"), { recursive: true });
    writeFileSync(
      join(testRoot, "sessions", "session-1", "transcript.json"),
      "{}",
    );
    mkdirSync(join(testRoot, "writing-templates", "weekly"), {
      recursive: true,
    });
    writeFileSync(
      join(testRoot, "writing-templates", "weekly", "template.md"),
      "周报模板",
    );

    const profile = "employee-one";
    const first = planLegacyEmployeeMigration(profile, "user-one");
    expect(first.shouldMigrate).toBe(true);
    expect(await prepareLegacyEmployeeMigration(first)).toBe(true);
    expect(
      readFileSync(
        join(
          testRoot,
          "profiles",
          profile,
          "sessions",
          "session-1",
          "transcript.json",
        ),
        "utf8",
      ),
    ).toBe("{}");
    expect(
      readFileSync(
        join(
          testRoot,
          "profiles",
          profile,
          "writing-templates",
          "weekly",
          "template.md",
        ),
        "utf8",
      ),
    ).toBe("周报模板");

    expect(planLegacyEmployeeMigration(profile, "user-one").pending).toBe(true);
    completeLegacyEmployeeMigration(profile, "user-one");
    expect(
      planLegacyEmployeeMigration("employee-two", "user-two").shouldMigrate,
    ).toBe(false);
  });
});
