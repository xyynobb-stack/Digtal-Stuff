import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moveExtractedRuntime } from "../scripts/prepare-portable-git.mjs";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("PortableGit staging", () => {
  // @lat: [[desktop-updates#Bundled runtime updates]]
  it("copies and removes the extracted directory when rename crosses volumes", () => {
    const root = mkdtempSync(join(tmpdir(), "portable-git-move-"));
    tempRoots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    mkdirSync(join(source, "cmd"), { recursive: true });
    writeFileSync(join(source, "cmd", "git.exe"), "portable git");

    const renameSync = vi.fn(() => {
      throw Object.assign(new Error("cross-device link not permitted"), {
        code: "EXDEV",
      });
    });

    moveExtractedRuntime(source, destination, { renameSync });

    expect(renameSync).toHaveBeenCalledWith(source, destination);
    expect(readFileSync(join(destination, "cmd", "git.exe"), "utf8")).toBe(
      "portable git",
    );
    expect(() => readFileSync(join(source, "cmd", "git.exe"))).toThrow();
  });

  it("does not hide errors other than cross-volume moves", () => {
    const denied = Object.assign(new Error("access denied"), {
      code: "EACCES",
    });
    expect(() =>
      moveExtractedRuntime("source", "destination", {
        renameSync: () => {
          throw denied;
        },
      }),
    ).toThrow(denied);
  });
});
