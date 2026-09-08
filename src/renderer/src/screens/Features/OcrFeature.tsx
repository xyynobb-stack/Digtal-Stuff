import { useState } from "react";
import { Check, Copy, FileText, ScanText, Upload } from "lucide-react";
import type {
  ContractDocumentBlock,
  FeaturePickedFile,
  OcrDocumentResult,
} from "../../../../shared/feature-workspace";

function fileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function OcrBlocks({
  blocks,
  fallback,
}: {
  blocks?: ContractDocumentBlock[];
  fallback: string;
}): React.JSX.Element {
  if (!blocks?.length) return <pre>{fallback || "未识别到文字"}</pre>;
  return (
    <div className="feature-ocr-content">
      {blocks.map((block) => {
        if (block.type === "paragraph") {
          if (block.style === "heading") {
            const level = Math.min(Math.max(block.level || 2, 1), 6);
            return (
              <div
                className={`feature-ocr-heading level-${level}`}
                key={block.id}
              >
                {block.text}
              </div>
            );
          }
          return (
            <p className="feature-ocr-paragraph" key={block.id}>
              {block.text}
            </p>
          );
        }
        const totalWidth = block.columnWidths.reduce(
          (sum, width) => sum + width,
          0,
        );
        return (
          <div className="feature-ocr-table-wrap" key={block.id}>
            <table className="feature-ocr-table">
              {totalWidth > 0 && (
                <colgroup>
                  {block.columnWidths.map((width, index) => (
                    <col
                      key={`${block.id}-col-${index}`}
                      style={{ width: `${(width / totalWidth) * 100}%` }}
                    />
                  ))}
                </colgroup>
              )}
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.id}>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.id}
                        rowSpan={cell.rowSpan}
                        colSpan={cell.colSpan}
                      >
                        {cell.text}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export default function OcrFeature(): React.JSX.Element {
  const [file, setFile] = useState<FeaturePickedFile | null>(null);
  const [result, setResult] = useState<OcrDocumentResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const pick = async (): Promise<void> => {
    setError("");
    const selected = await window.hermesAPI.pickFeatureFile("ocr");
    if (selected) {
      setFile(selected);
      setResult(null);
    }
  };

  const run = async (): Promise<void> => {
    if (!file || running) return;
    setRunning(true);
    setError("");
    try {
      const response = await window.hermesAPI.runFeatureOcr(file.path);
      if (!response.success || !response.data)
        throw new Error(response.error || "识别失败");
      setResult(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!result) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="feature-detail">
      <header className="feature-detail-header">
        <span className="feature-title-icon">
          <ScanText size={23} />
        </span>
        <div>
          <h1>OCR 文字识别</h1>
          <p>文字层在本地提取；图片和扫描页面会发送至 MinerU 解析。</p>
        </div>
      </header>
      <div className="feature-action-bar">
        <button
          className="feature-secondary-button"
          type="button"
          onClick={() => void pick()}
        >
          <Upload size={16} /> 选择图片或 PDF
        </button>
        <button
          className="feature-primary-button"
          type="button"
          disabled={!file || running}
          onClick={() => void run()}
        >
          {running ? "正在识别…" : "开始识别"}
        </button>
      </div>
      {file && (
        <div className="feature-file">
          <FileText size={18} />
          <span>
            <strong>{file.name}</strong>
            <small>{fileSize(file.size)}</small>
          </span>
        </div>
      )}
      {error && <div className="feature-error">{error}</div>}
      {result && (
        <div className="feature-result-card">
          <header>
            <div>
              <strong>识别结果</strong>
              <small>
                {result.pages.length} 页 ·{" "}
                {(result.elapsedMs / 1000).toFixed(1)} 秒
              </small>
            </div>
            <button type="button" onClick={() => void copy()}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? "已复制" : "复制全文"}
            </button>
          </header>
          <div className="feature-ocr-pages">
            {result.pages.map((page) => (
              <section key={page.page}>
                <h3>
                  第 {page.page} 页{" "}
                  <span>
                    {page.source === "mineru"
                      ? "MinerU"
                      : page.source === "ocr"
                        ? "本地 OCR"
                        : "文本层"}
                  </span>
                </h3>
                <OcrBlocks blocks={page.blocks} fallback={page.text} />
              </section>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
