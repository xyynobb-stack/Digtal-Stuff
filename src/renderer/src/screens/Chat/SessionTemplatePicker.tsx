import { useCallback, useEffect, useState } from "react";
import { Check, FileText, X } from "lucide-react";
import type { WritingTemplate } from "../../../../shared/writing-templates";

interface SessionTemplatePickerProps {
  profile?: string;
  activeTemplate: WritingTemplate | null;
  onChange: (template: WritingTemplate | null) => void;
}

/** Select one original writing-template file for the current conversation. */
// @lat: [[discover#Chat template activation]]
export function SessionTemplatePicker({
  profile,
  activeTemplate,
  onChange,
}: SessionTemplatePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WritingTemplate[]>([]);
  const [loading, setLoading] = useState(false);

  const loadTemplates = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setTemplates(await window.hermesAPI.listWritingTemplates(profile));
    } catch {
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    const refresh = (): void => void loadTemplates();
    window.addEventListener("hermes-writing-templates-changed", refresh);
    return () =>
      window.removeEventListener("hermes-writing-templates-changed", refresh);
  }, [loadTemplates]);

  return (
    <div className="session-skill-picker">
      <button
        type="button"
        className={`btn-ghost session-skill-trigger ${activeTemplate ? "session-skill-trigger-active" : ""}`}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void loadTemplates();
        }}
        title="为当前聊天选择写作模板"
        aria-expanded={open}
      >
        <FileText size={14} />
        写作模板
      </button>
      {open && (
        <div
          className="session-skill-popover session-template-popover"
          role="dialog"
          aria-label="当前聊天的写作模板"
        >
          <div className="session-skill-popover-header">
            <strong>当前聊天写作模板</strong>
            <div className="session-skill-popover-actions">
              {activeTemplate && (
                <button
                  type="button"
                  className="btn-ghost session-skill-clear"
                  onClick={() => onChange(null)}
                >
                  清除选择
                </button>
              )}
              <button
                type="button"
                className="btn-ghost"
                onClick={() => setOpen(false)}
                aria-label="关闭"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          <p className="session-skill-help">
            选择后，原始模板文件会在本聊天的每次普通请求中交给 Agent 使用。
          </p>
          {loading ? (
            <div className="session-skill-empty">正在读取写作模板…</div>
          ) : templates.length === 0 ? (
            <div className="session-skill-empty">
              还没有写作模板，请先在“发现”中导入。
            </div>
          ) : (
            <div className="session-skill-list">
              {templates.map((template) => {
                const selected = activeTemplate?.id === template.id;
                return (
                  <button
                    type="button"
                    key={template.id}
                    className={`session-skill-option ${selected ? "session-skill-option-selected" : ""}`}
                    onClick={() => onChange(selected ? null : template)}
                  >
                    <span className="session-skill-option-copy">
                      <strong>{template.name}</strong>
                      <small>{template.fileName}</small>
                    </span>
                    {selected && (
                      <span className="session-skill-selected-label">
                        <Check size={15} />
                        已选择
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
