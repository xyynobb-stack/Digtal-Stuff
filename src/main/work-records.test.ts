// @vitest-environment node

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkRecordSnapshot } from "../shared/work-records";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn() },
}));

import { WorkRecordStore } from "./work-records";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function snapshot(revision: number): WorkRecordSnapshot {
  return {
    id: "turn-race",
    revision,
    profileId: "default",
    profileName: "测试员工",
    sessionId: "session-1",
    title: "异步工作记录",
    type: "general",
    status: "completed",
    prompt: "测试删除竞态",
    resultSummary: "完成",
    attachments: [],
    steps: [],
    createdAt: 100,
    updatedAt: 100 + revision,
    completedAt: 100 + revision,
  };
}

function createStore(): { store: WorkRecordStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "work-record-race-"));
  tempDirs.push(directory);
  const path = join(directory, "records.db");
  return { store: new WorkRecordStore(path), path };
}

function sqliteNativeModuleIsUsable(): boolean {
  const directory = mkdtempSync(join(tmpdir(), "work-record-probe-"));
  try {
    const store = new WorkRecordStore(join(directory, "probe.db"));
    store.close();
    return true;
  } catch {
    return false;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!sqliteNativeModuleIsUsable())(
  "WorkRecordStore deletion safety",
  () => {
    // @lat: [[work-records#Deletion safety]]
    it("does not let pending or late higher-revision snapshots recreate a deletion", () => {
      const { store, path } = createStore();
      store.enqueue(snapshot(1));
      expect(store.delete("turn-race")).toBe(true);
      store.flush();
      expect(store.get("turn-race")).toBeNull();

      store.enqueue(snapshot(99));
      store.flush();
      expect(store.get("turn-race")).toBeNull();
      store.close();

      const reopened = new WorkRecordStore(path);
      reopened.enqueue(snapshot(100));
      reopened.flush();
      expect(reopened.get("turn-race")).toBeNull();
      reopened.close();
    });
  },
);
