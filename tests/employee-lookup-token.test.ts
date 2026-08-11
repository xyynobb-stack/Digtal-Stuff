import { describe, expect, it } from "vitest";
import { mergeBundledEmployeeLookupToken } from "../src/main/employee-lookup-token";

describe("mergeBundledEmployeeLookupToken", () => {
  it("installs the bundled token into an empty environment", () => {
    expect(
      mergeBundledEmployeeLookupToken(
        "",
        "EMPLOYEE_LOOKUP_ADMIN_TOKEN=current-token\n",
      ),
    ).toBe("EMPLOYEE_LOOKUP_ADMIN_TOKEN=current-token\n");
  });

  it("replaces an empty token left by an older Hermes checkout", () => {
    expect(
      mergeBundledEmployeeLookupToken(
        "OTHER_KEY=kept\nEMPLOYEE_LOOKUP_ADMIN_TOKEN=\n",
        "EMPLOYEE_LOOKUP_ADMIN_TOKEN=current-token\n",
      ),
    ).toBe("OTHER_KEY=kept\nEMPLOYEE_LOOKUP_ADMIN_TOKEN=current-token\n");
  });

  it("replaces stale and duplicate token entries without changing other keys", () => {
    expect(
      mergeBundledEmployeeLookupToken(
        "EMPLOYEE_LOOKUP_ADMIN_TOKEN=old-one\nOTHER_KEY=kept\nEMPLOYEE_LOOKUP_ADMIN_TOKEN=old-two\n",
        "EMPLOYEE_LOOKUP_ADMIN_TOKEN='current-token'\n",
      ),
    ).toBe("OTHER_KEY=kept\nEMPLOYEE_LOOKUP_ADMIN_TOKEN=current-token\n");
  });

  it("rejects a missing or empty bundled token", () => {
    expect(() =>
      mergeBundledEmployeeLookupToken("OTHER_KEY=kept\n", ""),
    ).toThrow("Bundled employee lookup token is empty.");
    expect(() =>
      mergeBundledEmployeeLookupToken(
        "OTHER_KEY=kept\n",
        "EMPLOYEE_LOOKUP_ADMIN_TOKEN=\n",
      ),
    ).toThrow("Bundled employee lookup token is empty.");
  });
});
