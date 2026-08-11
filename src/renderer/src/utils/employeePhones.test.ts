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

  it("keeps different valid phone numbers", () => {
    rememberConfiguredEmployeePhone("15703020935");
    rememberConfiguredEmployeePhone("13987654321");

    expect(loadConfiguredEmployeePhones()).toEqual([
      "15703020935",
      "13987654321",
    ]);
  });

  it("persists employee username and available models by phone", () => {
    rememberConfiguredEmployee({
      phone: "13987654321",
      username: "szyg_test",
      models: ["Seedance-2.0", "Seedance-2.0"],
    });

    expect(loadConfiguredEmployees()).toEqual([
      {
        phone: "13987654321",
        username: "szyg_test",
        models: ["Seedance-2.0"],
      },
    ]);
  });

  it("keeps legacy phone-only records visible until they are reconfigured", () => {
    rememberConfiguredEmployeePhone("15703020935");

    expect(loadConfiguredEmployees()).toEqual([
      { phone: "15703020935", username: "", models: [] },
    ]);
  });
});
