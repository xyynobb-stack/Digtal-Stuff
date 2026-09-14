import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupInactiveRuntimeVersions,
  scheduleInactiveRuntimeCleanup,
} from "./runtime-cleanup";

const roots: string[] = [];

async function runtimeFixture(): Promise<{
  managedRoot: string;
  versionsRoot: string;
  currentVersionName: string;
  currentRepo: string;
}> {
  const managedRoot = await mkdtemp(join(tmpdir(), "jingyu-runtime-cleanup-"));
  roots.push(managedRoot);
  const versionsRoot = join(managedRoot, "versions");
  const currentVersionName = "0.7.63-current";
  const currentRepo = join(versionsRoot, currentVersionName, "hermes-agent");
  await mkdir(currentRepo, { recursive: true });
  await writeFile(
    join(managedRoot, "active-runtime.json"),
    JSON.stringify({ version: currentVersionName, repo: currentRepo }),
  );
  return { managedRoot, versionsRoot, currentVersionName, currentRepo };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("inactive Runtime cleanup", () => {
  // @lat: [[main-process#Offline Windows runtime#Inactive Runtime reclamation]]
  it("keeps only the active version directory", async () => {
    const fixture = await runtimeFixture();
    for (const name of [
      "0.7.61-old",
      ".failed-0.7.62-broken",
      ".staging-interrupted",
      ".deleting-0.7.60-leftover",
    ]) {
      await mkdir(join(fixture.versionsRoot, name), { recursive: true });
      await writeFile(join(fixture.versionsRoot, name, "payload"), "old");
    }
    await writeFile(join(fixture.versionsRoot, "README.txt"), "not a version");

    const logger = { info: vi.fn(), warn: vi.fn() };
    const result = await cleanupInactiveRuntimeVersions({
      ...fixture,
      logger,
    });

    expect(result.deleted).toHaveLength(4);
    expect(result.failed).toEqual([]);
    expect(
      existsSync(join(fixture.versionsRoot, fixture.currentVersionName)),
    ).toBe(true);
    expect(
      await readFile(join(fixture.versionsRoot, "README.txt"), "utf8"),
    ).toBe("not a version");
  });

  it("does nothing when the active pointer does not match", async () => {
    const fixture = await runtimeFixture();
    const oldVersion = join(fixture.versionsRoot, "0.7.61-old");
    await mkdir(oldVersion, { recursive: true });
    await writeFile(
      join(fixture.managedRoot, "active-runtime.json"),
      JSON.stringify({
        version: "another-version",
        repo: join(fixture.versionsRoot, "another-version", "hermes-agent"),
      }),
    );

    const result = await cleanupInactiveRuntimeVersions(fixture);

    expect(result.deleted).toEqual([]);
    expect(result.skippedReason).toContain("does not match");
    expect(existsSync(oldVersion)).toBe(true);
  });

  it("rejects an unsafe current version name before deleting anything", async () => {
    const fixture = await runtimeFixture();
    const oldVersion = join(fixture.versionsRoot, "0.7.61-old");
    await mkdir(oldVersion, { recursive: true });

    const result = await cleanupInactiveRuntimeVersions({
      ...fixture,
      currentVersionName: "../outside",
    });

    expect(result.deleted).toEqual([]);
    expect(result.skippedReason).toContain("unsafe");
    expect(existsSync(oldVersion)).toBe(true);
  });

  it("does not start recursive cleanup inside the install-check path", async () => {
    vi.useFakeTimers();
    const fixture = await runtimeFixture();
    const oldVersion = join(fixture.versionsRoot, "0.7.61-old");
    await mkdir(oldVersion, { recursive: true });

    const cancel = scheduleInactiveRuntimeCleanup(fixture, 10_000);
    await Promise.resolve();
    expect(existsSync(oldVersion)).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    cancel();
  });
});
