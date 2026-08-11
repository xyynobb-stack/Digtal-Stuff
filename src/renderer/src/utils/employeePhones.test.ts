import { beforeEach, describe, expect, it } from "vitest";
import {
  loadConfiguredEmployees,
  loadConfiguredEmployeePhones,
  normalizeEmployeePhone,
  rememberConfiguredEmployee,
  rememberConfiguredEmployeePhone,
} from "./employeePhones";

describe("configured employee phones", () => {
  beforeEach(() => window.localStorage.clear());

  it("normalizes spaces and hyphens", () => {
    expect(normalizeEmployeePhone("157 0302-0935")).toBe("15703020935");
  });

  it("persists each phone only once", () => {
    rememberConfiguredEmployeePhone("15703020935");
    rememberConfiguredEmployeePhone("157 0302-0935");

    expect(loadConfiguredEmployeePhones()).toEqual(["15703020935"]);
  });

  it("keeps only the most recently configured valid phone", () => {
    rememberConfiguredEmployeePhone("15703020935");
    rememberConfiguredEmployeePhone("13987654321");

    expect(loadConfiguredEmployeePhones()).toEqual(["13987654321"]);
  });

  it("persists employee real name and available models by phone", () => {
    rememberConfiguredEmployee({
      phone: "13987654321",
      realName: "张三",
      models: ["Seedance-2.0", "Seedance-2.0"],
    });

    expect(loadConfiguredEmployees()).toEqual([
      {
        phone: "13987654321",
        realName: "张三",
        models: ["Seedance-2.0"],
      },
    ]);
  });

  it("keeps legacy phone-only records visible until they are reconfigured", () => {
    rememberConfiguredEmployeePhone("15703020935");

    expect(loadConfiguredEmployees()).toEqual([
      { phone: "15703020935", realName: "", models: [] },
    ]);
  });

  it("migrates the username field from existing local records", () => {
    window.localStorage.setItem(
      "hermes.configuredEmployees",
      JSON.stringify([
        {
          phone: "13987654321",
          username: "legacy_user",
          models: ["Seedance-2.0"],
        },
      ]),
    );

    expect(loadConfiguredEmployees()).toEqual([
      {
        phone: "13987654321",
        realName: "legacy_user",
        models: ["Seedance-2.0"],
      },
    ]);
  });
});
