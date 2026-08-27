import { describe, expect, it } from "vitest";
import { mergeBundledAihubKey } from "./managed-aihub-key";

describe("managed AIHub key", () => {
  it("appends the key and preserves unrelated profile settings", () => {
    const merged = mergeBundledAihubKey(
      "CUSTOM_PROVIDER_COMPANY_PLATFORM_KEY=primary\n# keep\n",
      "AIHUB_API_KEY=sk-build-fallback\n",
    );
    expect(merged).toContain("CUSTOM_PROVIDER_COMPANY_PLATFORM_KEY=primary");
    expect(merged).toContain("# keep");
    expect(merged).toContain("AIHUB_API_KEY=sk-build-fallback");
  });

  it("does not overwrite an existing non-empty profile key", () => {
    expect(
      mergeBundledAihubKey(
        "AIHUB_API_KEY=sk-profile-value\nOTHER=1\n",
        "AIHUB_API_KEY=sk-build-value\n",
      ),
    ).toBe("AIHUB_API_KEY=sk-profile-value\nOTHER=1\n");
  });
});
