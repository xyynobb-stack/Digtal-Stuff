import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import { app } from "electron";
import type {
  FeatureHistoryKind,
  FeatureHistoryRecord,
  FeatureHistorySaveInput,
  FeatureHistorySummary,
} from "../shared/feature-workspace";

const MAX_PAYLOAD_BYTES = 50 * 1024 * 1024;
const MAX_HISTORY_ROWS = 100;

function sourceNames(input: FeatureHistorySaveInput): string[] {
  return input.kind === "ocr"
    ? [input.file.name]
    : [input.oldFile.name, input.newFile.name];
}

function parseNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export class FeatureHistoryStore {
  // @lat: [[feature-workspace#Persistent processing history]]
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_history (
        id TEXT PRIMARY KEY,
        profile TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        source_names TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feature_history_profile_kind_updated
        ON feature_history(profile, kind, updated_at DESC);
    `);
  }

  save(input: FeatureHistorySaveInput): FeatureHistoryRecord {
    if (!input.profile.trim()) throw new Error("历史记录缺少 Profile");
    if (input.kind !== "ocr" && input.kind !== "contract-compare")
      throw new Error("不支持的功能历史类型");

    const id = input.id?.trim() || randomUUID();
    const existing = this.db
      .prepare(
        "SELECT profile, kind, created_at FROM feature_history WHERE id = ?",
      )
      .get(id) as
      | { profile: string; kind: FeatureHistoryKind; created_at: number }
      | undefined;
    if (
      existing &&
      (existing.profile !== input.profile || existing.kind !== input.kind)
    )
      throw new Error("不能覆盖其他 Profile 的功能历史");

    const now = Date.now();
    const createdAt = existing?.created_at ?? now;
    const record = {
      ...input,
      id,
      title: input.title.trim().slice(0, 180) || "未命名记录",
      createdAt,
      updatedAt: now,
    } as FeatureHistoryRecord;
    const payload = JSON.stringify(record);
    if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES)
      throw new Error("处理结果过大，无法保存到历史记录");

    this.db
      .prepare(
        `INSERT INTO feature_history
          (id, profile, kind, title, source_names, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          source_names = excluded.source_names,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.profile,
        input.kind,
        record.title,
        JSON.stringify(sourceNames(input)),
        payload,
        createdAt,
        now,
      );
    return record;
  }

  list(profile: string, kind: FeatureHistoryKind): FeatureHistorySummary[] {
    return (
      this.db
        .prepare(
          `SELECT id, kind, title, source_names, created_at, updated_at
           FROM feature_history
           WHERE profile = ? AND kind = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(profile, kind, MAX_HISTORY_ROWS) as Array<{
        id: string;
        kind: FeatureHistoryKind;
        title: string;
        source_names: string;
        created_at: number;
        updated_at: number;
      }>
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      sourceNames: parseNames(row.source_names),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  get(profile: string, id: string): FeatureHistoryRecord | null {
    const row = this.db
      .prepare(
        "SELECT payload_json FROM feature_history WHERE profile = ? AND id = ?",
      )
      .get(profile, id) as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.payload_json) as FeatureHistoryRecord;
    } catch {
      return null;
    }
  }

  delete(profile: string, id: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM feature_history WHERE profile = ? AND id = ?")
        .run(profile, id).changes > 0
    );
  }

  close(): void {
    this.db.close();
  }
}

let singleton: FeatureHistoryStore | null = null;

export function getFeatureHistoryStore(): FeatureHistoryStore {
  if (!singleton) {
    singleton = new FeatureHistoryStore(
      join(app.getPath("userData"), "feature-history", "feature-history.db"),
    );
  }
  return singleton;
}
