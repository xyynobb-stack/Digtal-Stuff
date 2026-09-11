import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OcrDocumentResult } from "../shared/feature-workspace";

interface FakeHistoryRow {
  id: string;
  profile: string;
  kind: string;
  title: string;
  source_names: string;
  payload_json: string;
  created_at: number;
  updated_at: number;
}

vi.mock("better-sqlite3", () => ({
  default: class FakeDatabase {
    private readonly rows = new Map<string, FakeHistoryRow>();

    pragma(): void {}
    exec(): void {}
    close(): void {}

    prepare(sql: string): {
      get: (...parameters: unknown[]) => unknown;
      all: (...parameters: unknown[]) => unknown[];
      run: (...parameters: unknown[]) => { changes: number };
    } {
      return {
        get: (...parameters: unknown[]) => {
          const [first, second] = parameters as [string, string];
          const row = this.rows.get(
            sql.includes("WHERE id = ?") ? first : second,
          );
          if (!row) return undefined;
          if (sql.includes("WHERE profile = ?") && row.profile !== first)
            return undefined;
          return sql.includes("payload_json")
            ? { payload_json: row.payload_json }
            : {
                profile: row.profile,
                kind: row.kind,
                created_at: row.created_at,
              };
        },
        all: (...parameters: unknown[]) => {
          const [profile, kind, limit] = parameters as [string, string, number];
          return [...this.rows.values()]
            .filter((row) => row.profile === profile && row.kind === kind)
            .sort((left, right) => right.updated_at - left.updated_at)
            .slice(0, limit)
            .map((row) => ({
              id: row.id,
              kind: row.kind,
              title: row.title,
              source_names: row.source_names,
              created_at: row.created_at,
              updated_at: row.updated_at,
            }));
        },
        run: (...parameters: unknown[]) => {
          if (sql.startsWith("INSERT")) {
            const [
              id,
              profile,
              kind,
              title,
              sourceNames,
              payload,
              createdAt,
              updatedAt,
            ] = parameters as [
              string,
              string,
              string,
              string,
              string,
              string,
              number,
              number,
            ];
            this.rows.set(id, {
              id,
              profile,
              kind,
              title,
              source_names: sourceNames,
              payload_json: payload,
              created_at: createdAt,
              updated_at: updatedAt,
            });
            return { changes: 1 };
          }
          const [profile, id] = parameters as [string, string];
          const row = this.rows.get(id);
          if (!row || row.profile !== profile) return { changes: 0 };
          this.rows.delete(id);
          return { changes: 1 };
        },
      };
    }
  },
}));

import { FeatureHistoryStore } from "./feature-history";

const temporaryDirectories: string[] = [];

function createStore(): FeatureHistoryStore {
  const directory = mkdtempSync(join(tmpdir(), "jingyuai-feature-history-"));
  temporaryDirectories.push(directory);
  return new FeatureHistoryStore(join(directory, "history.db"));
}

const result: OcrDocumentResult = {
  fileName: "scan.pdf",
  text: "识别结果",
  elapsedMs: 12,
  pages: [{ page: 1, text: "识别结果", source: "mineru" }],
};

describe("FeatureHistoryStore", () => {
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  // @lat: [[feature-workspace#Persistent processing history]]
  it("persists results per profile and supports update and deletion", () => {
    const store = createStore();
    const saved = store.save({
      profile: "employee-a",
      kind: "ocr",
      title: "扫描合同",
      file: {
        path: "C:\\contracts\\scan.pdf",
        name: "scan.pdf",
        size: 100,
        extension: ".pdf",
      },
      result,
    });

    expect(store.list("employee-a", "ocr")).toEqual([
      expect.objectContaining({ id: saved.id, sourceNames: ["scan.pdf"] }),
    ]);
    expect(store.list("employee-b", "ocr")).toEqual([]);
    expect(store.get("employee-a", saved.id)).toEqual(saved);

    const updated = store.save({ ...saved, title: "已解读扫描合同" });
    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(store.list("employee-a", "ocr")[0].title).toBe("已解读扫描合同");

    expect(store.delete("employee-b", saved.id)).toBe(false);
    expect(store.delete("employee-a", saved.id)).toBe(true);
    expect(store.get("employee-a", saved.id)).toBeNull();
    store.close();
  });
});
