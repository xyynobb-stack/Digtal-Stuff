import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WorkRecordDetail,
  WorkRecordStatus,
  WorkRecordSummary,
  WorkRecordType,
} from "../../../../shared/work-records";
import { Download, Pencil, Search, Trash, X } from "../../assets/icons";

interface WorkRecordsProps {
  profile: string;
  profileName: string;
  visible: boolean;
  onOpenSession: (sessionId: string) => void;
}

const TYPE_LABELS: Record<WorkRecordType, string> = {
  document: "文件处理",
  research: "资料检索",
  reminder: "提醒任务",
  analysis: "数据分析",
  general: "其他工作",
};

const STATUS_LABELS: Record<WorkRecordStatus, string> = {
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
};

function groupLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  if (date.getTime() >= start) return "今天";
  if (date.getTime() >= start - 86_400_000) return "昨天";
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function WorkRecords({
  profile,
  profileName,
  visible,
  onOpenSession,
}: WorkRecordsProps): React.JSX.Element {
  const [records, setRecords] = useState<WorkRecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkRecordDetail | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<WorkRecordType | "all">("all");
  const [status, setStatus] = useState<WorkRecordStatus | "all">("all");
  const [bannerVisible, setBannerVisible] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<WorkRecordDetail | null>(
    null,
  );
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const refreshRevisionRef = useRef(0);
  const deletedRecordIdsRef = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const refreshRevision = ++refreshRevisionRef.current;
    const next = await window.hermesAPI.listWorkRecords({
      profileId: profile,
      title: search,
      type,
      status,
    });
    if (refreshRevision !== refreshRevisionRef.current) return;
    const visibleRecords = next.filter(
      (record) => !deletedRecordIdsRef.current.has(record.id),
    );
    setRecords(visibleRecords);
    setSelectedId((current) =>
      current && visibleRecords.some((record) => record.id === current)
        ? current
        : (visibleRecords[0]?.id ?? null),
    );
  }, [profile, search, type, status]);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => void refresh(), 120);
    return () => window.clearTimeout(timer);
  }, [visible, refresh]);

  useEffect(
    () =>
      window.hermesAPI.onWorkRecordsChanged(() => {
        if (visible) void refresh();
      }),
    [visible, refresh],
  );

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void window.hermesAPI.getWorkRecord(selectedId).then((next) => {
      if (!cancelled) setDetail(next);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedId, records]);

  useEffect(() => {
    setRenaming(false);
    setRenameDraft("");
    setRenameError(null);
    setRenameSaving(false);
  }, [selectedId]);

  const grouped = useMemo(() => {
    const groups: Array<{ label: string; records: WorkRecordSummary[] }> = [];
    for (const record of records) {
      const label = groupLabel(record.createdAt);
      const last = groups[groups.length - 1];
      if (!last || last.label !== label)
        groups.push({ label, records: [record] });
      else last.records.push(record);
    }
    return groups;
  }, [records]);

  const beginRename = (): void => {
    if (!detail) return;
    setRenameDraft(detail.title);
    setRenameError(null);
    setRenaming(true);
  };

  const cancelRename = (): void => {
    setRenaming(false);
    setRenameDraft("");
    setRenameError(null);
  };

  const saveRename = async (): Promise<void> => {
    if (!detail || renameSaving) return;
    const title = renameDraft.trim();
    if (!title) {
      setRenameError("记录名称不能为空");
      return;
    }
    if (title === detail.title) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const saved = await window.hermesAPI.renameWorkRecord(detail.id, title);
      if (!saved) {
        setRenameError("保存失败，请稍后重试");
        return;
      }
      setDetail((current) =>
        current?.id === detail.id ? { ...current, title } : current,
      );
      setRenaming(false);
      setRenameDraft("");
      await refresh();
    } catch {
      setRenameError("保存失败，请稍后重试");
    } finally {
      setRenameSaving(false);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget || deleteSaving) return;
    const targetId = deleteTarget.id;
    setDeleteSaving(true);
    setDeleteError(null);
    deletedRecordIdsRef.current.add(targetId);
    try {
      const deleted = await window.hermesAPI.deleteWorkRecord(targetId);
      if (!deleted) {
        deletedRecordIdsRef.current.delete(targetId);
        setDeleteError("删除失败，这条记录可能已经不存在");
        void refresh();
        return;
      }
      setRecords((current) =>
        current.filter((record) => record.id !== targetId),
      );
      setDetail((current) => (current?.id === targetId ? null : current));
      setSelectedId((current) => (current === targetId ? null : current));
      setDeleteTarget(null);
      await refresh();
    } catch {
      deletedRecordIdsRef.current.delete(targetId);
      setDeleteError("删除失败，请稍后重试");
      void refresh();
    } finally {
      setDeleteSaving(false);
    }
  };

  return (
    <section className="work-records-screen">
      <header className="work-records-header">
        <div>
          <h1>
            我的记录 <span>共 {records.length} 条</span>
          </h1>
          <p>保留最近 6 个月 · 当前员工档案：{profileName}</p>
        </div>
        <button
          className="work-records-export"
          onClick={() =>
            void window.hermesAPI.exportWorkRecords({
              profileId: profile,
              title: search,
              type,
              status,
            })
          }
        >
          <Download size={16} /> 导出我的记录
        </button>
      </header>

      {bannerVisible && (
        <div className="work-records-banner">
          <span>✣</span>
          <b>这是“我的记录”：</b>
          你让数字员工做过的工作都会保存在这里，随时回看、随时自证，只有你自己能看到。
          <button aria-label="关闭" onClick={() => setBannerVisible(false)}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className="work-records-card">
        <aside className="work-records-list-pane">
          <label className="work-records-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索我做过的事"
            />
          </label>
          <div className="work-records-filters">
            <select
              value={type}
              onChange={(e) =>
                setType(e.target.value as WorkRecordType | "all")
              }
            >
              <option value="all">全部类型</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as WorkRecordStatus | "all")
              }
            >
              <option value="all">全部状态</option>
              {Object.entries(STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="work-records-list">
            {grouped.length === 0 && (
              <div className="work-records-empty">暂无符合条件的工作记录</div>
            )}
            {grouped.map((group) => (
              <div key={group.label}>
                <div className="work-records-group-title">{group.label}</div>
                {group.records.map((record) => (
                  <button
                    key={record.id}
                    className={`work-records-list-item ${selectedId === record.id ? "active" : ""}`}
                    onClick={() => setSelectedId(record.id)}
                  >
                    <time>{timeLabel(record.createdAt)}</time>
                    <span>
                      <b>{record.title}</b>
                      <small>{TYPE_LABELS[record.type]}</small>
                    </span>
                    <i
                      className={`work-record-status-dot ${record.status}`}
                      title={STATUS_LABELS[record.status]}
                    />
                  </button>
                ))}
              </div>
            ))}
          </div>
        </aside>

        <article className="work-records-detail">
          {!detail ? (
            <div className="work-records-detail-empty">
              选择一条记录查看详情
            </div>
          ) : (
            <>
              <header>
                <div>
                  <small>
                    记录 · {new Date(detail.createdAt).toLocaleString("zh-CN")}
                  </small>
                  {renaming ? (
                    <div className="work-record-rename">
                      <input
                        autoFocus
                        maxLength={80}
                        value={renameDraft}
                        aria-label="记录名称"
                        onChange={(event) => {
                          setRenameDraft(event.target.value);
                          setRenameError(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveRename();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            cancelRename();
                          }
                        }}
                      />
                      <button
                        disabled={renameSaving}
                        onClick={() => void saveRename()}
                      >
                        {renameSaving ? "保存中…" : "保存"}
                      </button>
                      <button disabled={renameSaving} onClick={cancelRename}>
                        取消
                      </button>
                      {renameError && <small role="alert">{renameError}</small>}
                    </div>
                  ) : (
                    <h2>
                      {detail.title}{" "}
                      <button title="重命名" onClick={beginRename}>
                        <Pencil size={14} />
                      </button>
                    </h2>
                  )}
                </div>
                <span className={`work-record-status ${detail.status}`}>
                  {STATUS_LABELS[detail.status]}
                </span>
              </header>
              <div className="work-records-detail-scroll">
                <section>
                  <h3>我说</h3>
                  <p>{detail.prompt}</p>
                  {detail.attachments.map((attachment, index) => (
                    <button
                      className="work-record-attachment"
                      key={`${attachment.name}-${index}`}
                      onClick={() =>
                        void window.hermesAPI.openWorkRecordAttachment(
                          detail.id,
                          index,
                        )
                      }
                    >
                      📎 {attachment.name} <span>打开</span>
                    </button>
                  ))}
                </section>
                <section>
                  <h3>数字员工做了 {detail.steps.length || 1} 件事</h3>
                  {detail.steps.length ? (
                    detail.steps.map((step) => (
                      <div className="work-record-step" key={step.id}>
                        <i
                          className={`work-record-status-dot ${step.status}`}
                        />
                        <div>
                          <b>{step.label}</b>
                          {step.preview && (
                            <details className="work-record-step-details">
                              <summary>查看技术详情</summary>
                              <p>{step.preview}</p>
                            </details>
                          )}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="work-record-step">
                      <i
                        className={`work-record-status-dot ${detail.status}`}
                      />
                      <div>
                        <b>处理你的请求</b>
                      </div>
                    </div>
                  )}
                </section>
                {detail.resultSummary && (
                  <section>
                    <h3>结果摘要</h3>
                    <p className="work-record-result">{detail.resultSummary}</p>
                  </section>
                )}
              </div>
              <footer>
                <button
                  disabled={!detail.sessionId}
                  onClick={() =>
                    detail.sessionId && onOpenSession(detail.sessionId)
                  }
                >
                  ▢ 查看原对话
                </button>
                <button
                  onClick={() =>
                    void window.hermesAPI.exportWorkRecord(detail.id)
                  }
                >
                  <Download size={14} /> 导出这条记录
                </button>
                <button
                  className="work-record-delete-button"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteTarget(detail);
                  }}
                >
                  <Trash size={14} /> 删除记录
                </button>
              </footer>
            </>
          )}
        </article>
      </div>
      {deleteTarget && (
        <div
          className="work-record-delete-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleteSaving) {
              setDeleteTarget(null);
              setDeleteError(null);
            }
          }}
        >
          <div
            className="work-record-delete-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="work-record-delete-title"
          >
            <h2 id="work-record-delete-title">删除这条工作记录？</h2>
            <p>
              将删除“{deleteTarget.title}
              ”。原对话和源文件不会被删除，此操作无法撤销。
            </p>
            {deleteError && <small role="alert">{deleteError}</small>}
            <div>
              <button
                disabled={deleteSaving}
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteError(null);
                }}
              >
                取消
              </button>
              <button
                className="danger"
                disabled={deleteSaving}
                onClick={() => void confirmDelete()}
              >
                {deleteSaving ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
