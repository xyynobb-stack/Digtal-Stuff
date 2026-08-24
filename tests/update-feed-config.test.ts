import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const intranetFeed = "http://192.168.2.254/jingyuai-updates";

describe("desktop update feed", () => {
  // @lat: [[desktop-updates#Desktop Updates]]
  it.each(["electron-builder.yml", "dev-app-update.yml"])(
    "uses the company intranet generic provider in %s",
    (filename) => {
      const config = readFileSync(resolve(root, filename), "utf8");

      expect(config).toMatch(/provider:\s*generic/);
      expect(config).toContain(`url: ${intranetFeed}`);
      expect(config).not.toMatch(/provider:\s*github/);
    },
  );
});
