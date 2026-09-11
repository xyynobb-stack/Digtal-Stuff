import { useState } from "react";
import { Clock3, FileText, Trash2 } from "lucide-react";
import type { FeatureHistorySummary } from "../../../../shared/feature-workspace";

interface FeatureHistoryPanelProps {
  items: FeatureHistorySummary[];
  activeId?: string;
  loading?: boolean;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

function historyTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

export default function FeatureHistoryPanel({
  items,
  activeId,
  loading,
  onOpen,
  onDelete,
}: FeatureHistoryPanelProps): React.JSX.Element {
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  return (
    <section className="feature-history-panel" aria-label="历史记录">
      <header>
        <strong>历史记录</strong>
        <small>最多显示最近 100 条</small>
      </header>
      {loading ? (
        <div className="feature-history-empty">正在加载…</div>
      ) : items.length === 0 ? (
        <div className="feature-history-empty">暂无处理记录</div>
      ) : (
        <div className="feature-history-list">
          {items.map((item) => (
            <div
              className={`feature-history-item${item.id === activeId ? " active" : ""}`}
              key={item.id}
            >
              <button type="button" onClick={() => onOpen(item.id)}>
                <FileText size={17} />
                <span>
                  <strong title={item.title}>{item.title}</strong>
                  <small title={item.sourceNames.join(" / ")}>
                    {item.sourceNames.join(" / ")}
                  </small>
                  <small>
                    <Clock3 size={12} /> {historyTime(item.updatedAt)}
                  </small>
                </span>
              </button>
              <button
                className={`feature-history-delete${confirmDeleteId === item.id ? " confirming" : ""}`}
                type="button"
                aria-label={
                  confirmDeleteId === item.id
                    ? `确认删除历史记录 ${item.title}`
                    : `删除历史记录 ${item.title}`
                }
                title={
                  confirmDeleteId === item.id
                    ? "再次点击确认删除"
                    : "删除历史记录"
                }
                onClick={() => {
                  if (confirmDeleteId === item.id) {
                    setConfirmDeleteId("");
                    onDelete(item.id);
                  } else {
                    setConfirmDeleteId(item.id);
                  }
                }}
              >
                {confirmDeleteId === item.id ? "确认" : <Trash2 size={15} />}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
