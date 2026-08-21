import Database from "better-sqlite3";
import { app, dialog, shell } from "electron";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type {
  WorkRecordDetail,
  WorkRecordQuery,
  WorkRecordSnapshot,
  WorkRecordSummary,
} from "../shared/work-records";

const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_TITLE_LENGTH = 80;
const MAX_TEXT_LENGTH = 100_000;

function safeText(value: unknown, max = MAX_TEXT_LENGTH): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export class WorkRecordStore {
  private readonly db: Database.Database;
  private readonly pending = new Map<string, WorkRecordSnapshot>();
  private readonly deletedIds = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onChanged?: (ids: string[]) => void;

  constructor(dbPath: string, onChanged?: (ids: string[]) => void) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.onChanged = onChanged;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS work_records (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        profile_id TEXT NOT NULL,
        profile_name TEXT NOT NULL,
        session_id TEXT,
        local_title TEXT NOT NULL,
        manual_title TEXT,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_work_records_profile_updated
        ON work_records(profile_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS work_record_attachments (
        record_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT,
        size INTEGER,
        PRIMARY KEY(record_id, position),
        FOREIGN KEY(record_id) REFERENCES work_records(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS work_record_steps (
        record_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        status TEXT NOT NULL,
        preview TEXT,
        PRIMARY KEY(record_id, step_id),
        FOREIGN KEY(record_id) REFERENCES work_records(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS work_record_deletions (
        id TEXT PRIMARY KEY,
        deleted_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_work_record_deletions_deleted_at
        ON work_record_deletions(deleted_at);
    `);
    for (const row of this.db
      .prepare("SELECT id FROM work_record_deletions")
      .all() as Array<{ id: string }>) {
      this.deletedIds.add(row.id);
    }
    this.db
      .prepare(
        "UPDATE work_records SET status = 'interrupted' WHERE status = 'running'",
      )
      .run();
    this.prune();
  }

  enqueue(snapshot: WorkRecordSnapshot): void {
    if (
      !snapshot?.id ||
      !snapshot.profileId ||
      !Number.isFinite(snapshot.revision)
    )
      return;
    if (this.deletedIds.has(snapshot.id)) return;
    const current = this.pending.get(snapshot.id);
    if (!current || current.revision <= snapshot.revision)
      this.pending.set(snapshot.id, snapshot);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 80);
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    try {
      this.writeSnapshots(entries);
      this.onChanged?.(entries.map((entry) => entry.id));
    } catch (error) {
      console.error("[work-records] Failed to persist snapshots:", error);
    }
  }

  private writeSnapshots(entries: WorkRecordSnapshot[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO work_records (
        id, revision, profile_id, profile_name, session_id, local_title, type,
        status, prompt, result_summary, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        revision=excluded.revision, profile_id=excluded.profile_id,
        profile_name=excluded.profile_name, session_id=excluded.session_id,
        local_title=excluded.local_title, type=excluded.type,
        status=excluded.status, prompt=excluded.prompt,
        result_summary=excluded.result_summary, updated_at=excluded.updated_at,
        completed_at=excluded.completed_at
      WHERE excluded.revision >= work_records.revision
    `);
    const clearAttachments = this.db.prepare(
      "DELETE FROM work_record_attachments WHERE record_id = ?",
    );
    const addAttachment = this.db.prepare(`INSERT INTO work_record_attachments
      (record_id, position, name, kind, path, size) VALUES (?, ?, ?, ?, ?, ?)`);
    const clearSteps = this.db.prepare(
      "DELETE FROM work_record_steps WHERE record_id = ?",
    );
    const addStep = this.db.prepare(`INSERT INTO work_record_steps
      (record_id, step_id, position, name, label, status, preview) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const transaction = this.db.transaction(
      (snapshots: WorkRecordSnapshot[]) => {
        for (const item of snapshots) {
          if (this.deletedIds.has(item.id)) continue;
          const result = upsert.run(
            safeText(item.id, 160),
            item.revision,
            safeText(item.profileId, 120),
            safeText(item.profileName, 160),
            safeText(item.sessionId, 200) || null,
            safeText(item.title, MAX_TITLE_LENGTH),
            safeText(item.type, 30),
            safeText(item.status, 30),
            safeText(item.prompt),
            safeText(item.resultSummary) || null,
            item.createdAt,
            item.updatedAt,
            item.completedAt ?? null,
          );
          if (result.changes === 0) continue;
          clearAttachments.run(item.id);
          item.attachments
            .slice(0, 50)
            .forEach((attachment, index) =>
              addAttachment.run(
                item.id,
                index,
                safeText(attachment.name, 500),
                safeText(attachment.kind, 40),
                safeText(attachment.path, 4000) || null,
                attachment.size ?? null,
              ),
            );
          clearSteps.run(item.id);
          item.steps
            .slice(0, 100)
            .forEach((step) =>
              addStep.run(
                item.id,
                safeText(step.id, 200),
                step.position,
                safeText(step.name, 200),
                safeText(step.label, 500),
                safeText(step.status, 30),
                safeText(step.preview, 4000) || null,
              ),
            );
        }
      },
    );
    transaction(entries);
  }

  list(query: WorkRecordQuery): WorkRecordSummary[] {
    this.flush();
    const clauses = ["profile_id = ?", "updated_at >= ?"];
    const args: unknown[] = [
      query.profileId,
      query.since ?? Date.now() - RETENTION_MS,
    ];
    if (query.title?.trim()) {
      clauses.push(
        "LOWER(COALESCE(manual_title, local_title)) LIKE ? ESCAPE '\\'",
      );
      const escaped = query.title
        .trim()
        .toLocaleLowerCase()
        .replace(/[\\%_]/g, "\\$&");
      args.push(`%${escaped}%`);
    }
    if (query.type && query.type !== "all") {
      clauses.push("type = ?");
      args.push(query.type);
    }
    if (query.status && query.status !== "all") {
      clauses.push("status = ?");
      args.push(query.status);
    }
    return this.db
      .prepare(
        `SELECT id, profile_id, session_id,
      COALESCE(manual_title, local_title) AS title, type, status,
      created_at, updated_at, completed_at FROM work_records
      WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT 1000`,
      )
      .all(...args)
      .map((row) => mapSummary(row as Record<string, unknown>));
  }

  get(id: string): WorkRecordDetail | null {
    this.flush();
    const row = this.db
      .prepare(
        `SELECT id, profile_id, profile_name, session_id,
      COALESCE(manual_title, local_title) AS title, type, status, prompt,
      result_summary, created_at, updated_at, completed_at FROM work_records WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const attachments = this.db
      .prepare(
        `SELECT name, kind, path, size FROM work_record_attachments
      WHERE record_id = ? ORDER BY position`,
      )
      .all(id) as Array<Record<string, unknown>>;
    const steps = this.db
      .prepare(
        `SELECT step_id, name, label, status, position, preview
      FROM work_record_steps WHERE record_id = ? ORDER BY position`,
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      ...mapSummary(row),
      profileName: String(row.profile_name),
      prompt: String(row.prompt),
      resultSummary: row.result_summary
        ? String(row.result_summary)
        : undefined,
      attachments: attachments.map((a) => ({
        name: String(a.name),
        kind: String(a.kind),
        path: a.path ? String(a.path) : undefined,
        size: a.size == null ? undefined : Number(a.size),
      })),
      steps: steps.map((s) => ({
        id: String(s.step_id),
        name: String(s.name),
        label: String(s.label),
        status: s.status as "running" | "completed" | "failed",
        position: Number(s.position),
        preview: s.preview ? String(s.preview) : undefined,
      })),
    };
  }

  rename(id: string, title: string): boolean {
    this.flush();
    const normalized = title.trim().slice(0, MAX_TITLE_LENGTH);
    if (!normalized) return false;
    const result = this.db
      .prepare(
        "UPDATE work_records SET manual_title = ?, updated_at = ? WHERE id = ?",
      )
      .run(normalized, Date.now(), id);
    if (result.changes) this.onChanged?.([id]);
    return result.changes > 0;
  }

  // @lat: [[work-records#Deletion safety]]
  delete(id: string): boolean {
    const normalized = safeText(id, 160).trim();
    if (!normalized) return false;

    const pendingSnapshot = this.pending.get(normalized);
    this.pending.delete(normalized);
    const deletedAt = Date.now();
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO work_record_deletions (id, deleted_at) VALUES (?, ?)
          ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at`,
        )
        .run(normalized, deletedAt);
      this.db.prepare("DELETE FROM work_records WHERE id = ?").run(normalized);
    });

    // Mark before committing so neither a pending flush nor a renderer event
    // delivered after the click can resurrect this record in the same process.
    this.deletedIds.add(normalized);
    try {
      transaction();
    } catch (error) {
      this.deletedIds.delete(normalized);
      if (pendingSnapshot) this.pending.set(normalized, pendingSnapshot);
      throw error;
    }
    this.onChanged?.([normalized]);
    return true;
  }

  async exportAll(query: WorkRecordQuery): Promise<string | null> {
    const records = this.list(query);
    const result = await dialog.showSaveDialog({
      defaultPath: `我的记录-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const quote = (v: unknown): string =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["时间", "标题", "类型", "状态", "会话ID"].map(quote).join(","),
      ...records.map((r) =>
        [
          new Date(r.createdAt).toLocaleString(),
          r.title,
          r.type,
          r.status,
          r.sessionId ?? "",
        ]
          .map(quote)
          .join(","),
      ),
    ];
    writeFileSync(result.filePath, `\uFEFF${lines.join("\r\n")}`, "utf8");
    return result.filePath;
  }

  async exportOne(id: string): Promise<string | null> {
    const record = this.get(id);
    if (!record) return null;
    const result = await dialog.showSaveDialog({
      defaultPath: `${record.title.replace(/[<>:"/\\|?*]/g, "-")}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const body = [
      `# ${record.title}`,
      "",
      `- 时间：${new Date(record.createdAt).toLocaleString()}`,
      `- 状态：${record.status}`,
      "",
      "## 我说",
      "",
      record.prompt,
      "",
      "## 执行过程",
      "",
      ...record.steps.map((s) => `- ${s.label}（${s.status}）`),
      "",
      "## 结果",
      "",
      record.resultSummary ?? "暂无结果",
    ].join("\n");
    writeFileSync(result.filePath, body, "utf8");
    return result.filePath;
  }

  async openAttachment(id: string, index: number): Promise<boolean> {
    const record = this.get(id);
    const path = record?.attachments[index]?.path;
    if (!path) return false;
    return (await shell.openPath(path)) === "";
  }

  prune(now = Date.now()): void {
    this.db
      .prepare("DELETE FROM work_records WHERE updated_at < ?")
      .run(now - RETENTION_MS);
    const tombstoneCutoff = now - RETENTION_MS;
    const expired = this.db
      .prepare("SELECT id FROM work_record_deletions WHERE deleted_at < ?")
      .all(tombstoneCutoff) as Array<{ id: string }>;
    this.db
      .prepare("DELETE FROM work_record_deletions WHERE deleted_at < ?")
      .run(tombstoneCutoff);
    for (const row of expired) this.deletedIds.delete(row.id);
  }

  close(): void {
    this.flush();
    this.db.close();
  }
}

function mapSummary(row: Record<string, unknown>): WorkRecordSummary {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    sessionId: row.session_id ? String(row.session_id) : undefined,
    title: String(row.title),
    type: row.type as WorkRecordSummary["type"],
    status: row.status as WorkRecordSummary["status"],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt:
      row.completed_at == null ? undefined : Number(row.completed_at),
  };
}

let singleton: WorkRecordStore | null = null;
export function getWorkRecordStore(
  onChanged?: (ids: string[]) => void,
): WorkRecordStore | null {
  if (!singleton) {
    try {
      singleton = new WorkRecordStore(
        join(app.getPath("userData"), "work-records", "work-records.db"),
        onChanged,
      );
    } catch (error) {
      console.error(
        "[work-records] Failed to open local record database:",
        error,
      );
      return null;
    }
  }
  return singleton;
}
