import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import type { WritingTemplate } from "../../../shared/writing-templates";
import { Plus } from "../assets/icons";

interface WritingTemplateImportButtonProps {
  profile?: string;
  className?: string;
  disabled?: boolean;
  onImported?: (template: WritingTemplate) => void | Promise<void>;
}

/** Import one profile-local writing template through the existing Electron IPC. */
export function WritingTemplateImportButton({
  profile,
  className = "btn btn-secondary btn-sm",
  disabled = false,
  onImported,
}: WritingTemplateImportButtonProps): React.JSX.Element {
  const [importing, setImporting] = useState(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    requestVersion.current += 1;
    return () => {
      requestVersion.current += 1;
    };
  }, [profile]);

  async function handleImport(): Promise<void> {
    if (importing || disabled) return;
    const version = ++requestVersion.current;
    setImporting(true);
    try {
      const result = await window.hermesAPI.importWritingTemplate(profile);
      if (version !== requestVersion.current || result.canceled) return;
      if (!result.success || !result.template) {
        toast.error(result.error || "导入写作模板失败。");
        return;
      }
      await onImported?.(result.template);
      if (version !== requestVersion.current) return;
      window.dispatchEvent(new Event("hermes-writing-templates-changed"));
      toast.success(`已导入写作模板：${result.template.name}`);
    } catch (error) {
      if (version === requestVersion.current) {
        toast.error(
          error instanceof Error ? error.message : "导入写作模板失败。",
        );
      }
    } finally {
      if (version === requestVersion.current) setImporting(false);
    }
  }

  return (
    <button
      type="button"
      className={className}
      title="选择本地文件作为写作模板"
      onClick={() => void handleImport()}
      disabled={disabled || importing}
    >
      <Plus size={14} />
      {importing ? "正在添加…" : "添加写作模板"}
    </button>
  );
}
