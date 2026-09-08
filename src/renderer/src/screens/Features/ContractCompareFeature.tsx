import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  FileDiff,
  Search,
  Sparkles,
  Upload,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type {
  ContractAnalysisContext,
  ContractAnalysisPerspective,
  ContractComparisonResult,
  ContractDifference,
  ContractDifferenceKind,
  ContractDocumentStructure,
  FeaturePickedFile,
} from "../../../../shared/feature-workspace";

interface ContractCompareFeatureProps {
  profile: string;
}
interface SelectableModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  providerLabel?: string;
}

type DifferenceFilter = "all" | Exclude<ContractDifferenceKind, "unchanged">;
type DocumentSide = "old" | "new";

const KIND_LABEL = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  unchanged: "未变化",
} as const;
const CHANGE_KINDS: DifferenceFilter[] = [
  "all",
  "added",
  "removed",
  "modified",
];

function commonEdges(left: string, right: string): [number, number] {
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  const shortest = Math.min(leftChars.length, rightChars.length);
  let prefix = 0;
  while (prefix < shortest && leftChars[prefix] === rightChars[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    prefix + suffix < shortest &&
    leftChars[leftChars.length - suffix - 1] ===
      rightChars[rightChars.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return [prefix, suffix];
}

export function renderInlineDifference(
  text: string,
  counterpart: string,
  kind: ContractDifferenceKind,
  side: DocumentSide,
): ReactNode {
  if (!text)
    return <span className="contract-empty-line">此版本无对应内容</span>;
  if (kind === "unchanged") return text;
  if (kind === "added" || kind === "removed") {
    return <mark className={`contract-inline-mark ${kind}`}>{text}</mark>;
  }

  const chars = Array.from(text);
  const [prefix, suffix] = commonEdges(text, counterpart);
  const middleEnd = suffix ? chars.length - suffix : chars.length;
  const before = chars.slice(0, prefix).join("");
  const changed = chars.slice(prefix, middleEnd).join("");
  const after = suffix ? chars.slice(-suffix).join("") : "";
  return (
    <>
      {before}
      <mark className={`contract-inline-mark modified ${side}`}>
        {changed || text}
      </mark>
      {after}
    </>
  );
}

function DocumentRow({
  item,
  side,
  active,
}: {
  item: ContractDifference;
  side: DocumentSide;
  active: boolean;
}): React.JSX.Element {
  const text = side === "old" ? item.oldText : item.newText;
  const counterpart = side === "old" ? item.newText : item.oldText;
  const paragraphIndex = side === "old" ? item.oldIndex : item.newIndex;
  return (
    <div
      className={`contract-document-row ${item.kind}${active ? " active" : ""}`}
      data-diff-id={item.id}
    >
      <span className="contract-paragraph-number">{paragraphIndex || ""}</span>
      <p>{renderInlineDifference(text, counterpart, item.kind, side)}</p>
    </div>
  );
}

function DocumentContent({
  document,
  differences,
  side,
  activeDiffId,
}: {
  document: ContractDocumentStructure;
  differences: ContractDifference[];
  side: DocumentSide;
  activeDiffId: string;
}): React.JSX.Element {
  const differencesByUnit = new Map<string, ContractDifference>();
  for (const difference of differences) {
    const unitId =
      side === "old" ? difference.oldUnitId : difference.newUnitId;
    if (unitId) differencesByUnit.set(unitId, difference);
  }

  return (
    <>
      {document.blocks.map((block, blockIndex) => {
        if (block.type === "paragraph") {
          const difference = differencesByUnit.get(block.id);
          if (!difference) {
            return (
              <div className="contract-document-row unchanged" key={block.id}>
                <span className="contract-paragraph-number">
                  {blockIndex + 1}
                </span>
                <p>{block.text}</p>
              </div>
            );
          }
          return (
            <DocumentRow
              key={block.id}
              item={difference}
              side={side}
              active={difference.id === activeDiffId}
            />
          );
        }

        const totalWidth = block.columnWidths.reduce(
          (sum, width) => sum + width,
          0,
        );
        return (
          <div className="contract-table-wrap" key={block.id}>
            <table className="contract-document-table">
              {totalWidth > 0 && (
                <colgroup>
                  {block.columnWidths.map((width, index) => (
                    <col
                      // Word 表格允许等宽列，位置是这里更稳定的键。
                      key={`${block.id}-col-${index}`}
                      style={{ width: `${(width / totalWidth) * 100}%` }}
                    />
                  ))}
                </colgroup>
              )}
              <tbody>
                {block.rows.map((row) => (
                  <tr key={row.id}>
                    {row.cells.map((cell) => {
                      const difference = differencesByUnit.get(cell.id);
                      const kind = difference?.kind || "unchanged";
                      const counterpart = difference
                        ? side === "old"
                          ? difference.newText
                          : difference.oldText
                        : cell.text;
                      return (
                        <td
                          key={cell.id}
                          rowSpan={cell.rowSpan}
                          colSpan={cell.colSpan}
                          className={`${kind}${difference?.id === activeDiffId ? " active" : ""}`}
                          data-diff-id={difference?.id}
                        >
                          {difference
                            ? renderInlineDifference(
                                cell.text,
                                counterpart,
                                kind,
                                side,
                              )
                            : cell.text}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

export default function ContractCompareFeature({
  profile,
}: ContractCompareFeatureProps): React.JSX.Element {
  const [oldFile, setOldFile] = useState<FeaturePickedFile | null>(null);
  const [newFile, setNewFile] = useState<FeaturePickedFile | null>(null);
  const [result, setResult] = useState<ContractComparisonResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [models, setModels] = useState<SelectableModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [perspective, setPerspective] =
    useState<ContractAnalysisPerspective>("neutral");
  const [contextMode, setContextMode] =
    useState<ContractAnalysisContext>("changes-only");
  const [analysis, setAnalysis] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [syncScroll, setSyncScroll] = useState(true);
  const [zoom, setZoom] = useState(100);
  const [filter, setFilter] = useState<DifferenceFilter>("all");
  const [search, setSearch] = useState("");
  const [activeDiffId, setActiveDiffId] = useState("");
  const [resultLimit, setResultLimit] = useState(80);
  const oldPaneRef = useRef<HTMLDivElement>(null);
  const newPaneRef = useRef<HTMLDivElement>(null);
  const synchronizingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      window.hermesAPI.listModels(),
      window.hermesAPI.getModelConfig(profile),
    ]).then(([items, config]) => {
      if (cancelled) return;
      setModels(items);
      const saved = localStorage.getItem(`jingyuai.contract-model.${profile}`);
      const matching =
        items.find((item) => item.id === saved) ||
        items.find(
          (item) =>
            item.model === config.model && item.provider === config.provider,
        ) ||
        items[0];
      setModelId(matching?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [profile]);

  const selectedModel = useMemo(
    () => models.find((item) => item.id === modelId),
    [models, modelId],
  );
  const changes = useMemo(
    () => result?.differences.filter((item) => item.kind !== "unchanged") || [],
    [result],
  );
  const filteredChanges = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return changes.filter((item) => {
      if (filter !== "all" && item.kind !== filter) return false;
      if (!query) return true;
      return `${item.oldText}\n${item.newText}`
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [changes, filter, search]);
  const activeIndex = filteredChanges.findIndex(
    (item) => item.id === activeDiffId,
  );

  const pick = async (side: DocumentSide): Promise<void> => {
    const selected = await window.hermesAPI.pickFeatureFile("contract");
    if (!selected) return;
    if (side === "old") setOldFile(selected);
    else setNewFile(selected);
    setResult(null);
    setAnalysis("");
    setError("");
  };

  const compare = async (): Promise<void> => {
    if (!oldFile || !newFile || running) return;
    setRunning(true);
    setError("");
    setAnalysis("");
    try {
      const response = await window.hermesAPI.compareContracts(
        oldFile.path,
        newFile.path,
      );
      if (!response.success || !response.data)
        throw new Error(response.error || "比对失败");
      setResult(response.data);
      const firstChange = response.data.differences.find(
        (item) => item.kind !== "unchanged",
      );
      setActiveDiffId(firstChange?.id || "");
      setFilter("all");
      setSearch("");
      setResultLimit(80);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  const analyze = async (): Promise<void> => {
    if (!result || !selectedModel || analyzing) return;
    localStorage.setItem(
      `jingyuai.contract-model.${profile}`,
      selectedModel.id,
    );
    setAnalyzing(true);
    setError("");
    try {
      const response = await window.hermesAPI.analyzeContract({
        profile,
        provider: selectedModel.provider,
        model: selectedModel.model,
        baseUrl: selectedModel.baseUrl || "",
        perspective,
        contextMode,
        comparison: result,
      });
      if (!response.success || !response.data)
        throw new Error(response.error || "AI 解读失败");
      setAnalysis(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAnalyzing(false);
    }
  };

  const syncDocumentScroll = (
    source: DocumentSide,
    event: UIEvent<HTMLDivElement>,
  ): void => {
    if (!syncScroll || synchronizingRef.current) return;
    const sourceElement = event.currentTarget;
    const targetElement =
      source === "old" ? newPaneRef.current : oldPaneRef.current;
    if (!targetElement) return;
    const sourceRange = sourceElement.scrollHeight - sourceElement.clientHeight;
    const targetRange = targetElement.scrollHeight - targetElement.clientHeight;
    synchronizingRef.current = true;
    targetElement.scrollTop = sourceRange
      ? (sourceElement.scrollTop / sourceRange) * targetRange
      : 0;
    requestAnimationFrame(() => {
      synchronizingRef.current = false;
    });
  };

  const focusDifference = (item: ContractDifference): void => {
    setActiveDiffId(item.id);
    for (const pane of [oldPaneRef.current, newPaneRef.current]) {
      pane
        ?.querySelector<HTMLElement>(`[data-diff-id="${item.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const moveDifference = (offset: number): void => {
    if (!filteredChanges.length) return;
    const current = activeIndex < 0 ? 0 : activeIndex;
    const next = Math.min(
      filteredChanges.length - 1,
      Math.max(0, current + offset),
    );
    focusDifference(filteredChanges[next]);
  };

  return (
    <div className="feature-detail contract-compare-detail">
      <header className="feature-detail-header">
        <span className="feature-title-icon">
          <FileDiff size={23} />
        </span>
        <div>
          <h1>合同比对</h1>
          <p>左右对照原文并定位变化，再由你选择的模型解读风险。</p>
        </div>
      </header>
      <div className="contract-file-grid">
        {(["old", "new"] as const).map((side) => {
          const file = side === "old" ? oldFile : newFile;
          return (
            <button
              key={side}
              type="button"
              className="contract-file-picker"
              onClick={() => void pick(side)}
            >
              <Upload size={20} />
              <span>
                <strong>
                  {side === "old" ? "选择旧版合同" : "选择新版合同"}
                </strong>
                <small>{file?.name || "支持 DOCX、PDF，最大 50 MB"}</small>
              </span>
            </button>
          );
        })}
      </div>
      <button
        className="feature-primary-button contract-compare-button"
        type="button"
        disabled={!oldFile || !newFile || running}
        onClick={() => void compare()}
      >
        {running ? "正在比对…" : "开始精确比对"}
      </button>
      {error && <div className="feature-error">{error}</div>}
      {result && (
        <>
          <div className="contract-review-toolbar">
            <label className="contract-sync-toggle">
              <input
                type="checkbox"
                checked={syncScroll}
                onChange={(event) => setSyncScroll(event.target.checked)}
              />
              同步滚动
            </label>
            <span className="contract-toolbar-divider" />
            <button
              type="button"
              title="缩小"
              onClick={() => setZoom((value) => Math.max(75, value - 10))}
            >
              <ZoomOut size={16} />
            </button>
            <span>{zoom}%</span>
            <button
              type="button"
              title="放大"
              onClick={() => setZoom((value) => Math.min(140, value + 10))}
            >
              <ZoomIn size={16} />
            </button>
            <span className="contract-toolbar-divider" />
            <button
              type="button"
              disabled={activeIndex <= 0}
              onClick={() => moveDifference(-1)}
            >
              <ChevronUp size={16} /> 上一处
            </button>
            <button
              type="button"
              disabled={
                activeIndex < 0 || activeIndex >= filteredChanges.length - 1
              }
              onClick={() => moveDifference(1)}
            >
              <ChevronDown size={16} /> 下一处
            </button>
            <span className="contract-change-position">
              {filteredChanges.length
                ? `${Math.max(activeIndex + 1, 1)} / ${filteredChanges.length} 处变化`
                : "没有符合条件的变化"}
            </span>
          </div>

          <div className="contract-review-layout">
            <div className="contract-document-comparison">
              {(["old", "new"] as const).map((side) => (
                <section key={side} className="contract-document-pane">
                  <header>
                    <span className={side}>
                      {side === "old" ? "旧版" : "新版"}
                    </span>
                    <strong>
                      {side === "old" ? result.oldFileName : result.newFileName}
                    </strong>
                  </header>
                  <div
                    ref={side === "old" ? oldPaneRef : newPaneRef}
                    className="contract-document-scroll"
                    style={{ fontSize: `${zoom}%` }}
                    onScroll={(event) => syncDocumentScroll(side, event)}
                  >
                    <div className="contract-document-page">
                      {side === "old" && result.oldDocument ? (
                        <DocumentContent
                          document={result.oldDocument}
                          differences={result.differences}
                          side={side}
                          activeDiffId={activeDiffId}
                        />
                      ) : side === "new" && result.newDocument ? (
                        <DocumentContent
                          document={result.newDocument}
                          differences={result.differences}
                          side={side}
                          activeDiffId={activeDiffId}
                        />
                      ) : (
                        result.differences.map((item) => (
                          <DocumentRow
                            key={`${side}-${item.id}`}
                            item={item}
                            side={side}
                            active={item.id === activeDiffId}
                          />
                        ))
                      )}
                    </div>
                  </div>
                </section>
              ))}
            </div>

            <aside className="contract-result-sidebar">
              <header>
                <strong>比对结果</strong>
                <span>{changes.length} 处变化</span>
              </header>
              <div className="contract-summary compact">
                {(["added", "removed", "modified"] as const).map((kind) => (
                  <span key={kind} className={kind}>
                    <strong>{result.summary[kind]}</strong>
                    <small>{KIND_LABEL[kind]}</small>
                  </span>
                ))}
              </div>
              <div className="contract-result-filters">
                <select
                  aria-label="差异类型"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value as DifferenceFilter);
                    setResultLimit(80);
                  }}
                >
                  {CHANGE_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind === "all" ? "全部类型" : KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
                <label>
                  <Search size={15} />
                  <input
                    aria-label="搜索差异"
                    value={search}
                    placeholder="搜索变化内容"
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setResultLimit(80);
                    }}
                  />
                </label>
              </div>
              <div className="contract-result-list">
                {filteredChanges.slice(0, resultLimit).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`${item.kind}${item.id === activeDiffId ? " active" : ""}`}
                    onClick={() => focusDifference(item)}
                  >
                    <span>
                      <i /> {KIND_LABEL[item.kind]}
                    </span>
                    <small>{item.newText || item.oldText}</small>
                  </button>
                ))}
                {filteredChanges.length > resultLimit && (
                  <button
                    type="button"
                    className="contract-load-more"
                    onClick={() => setResultLimit((value) => value + 80)}
                  >
                    再显示 80 条
                  </button>
                )}
                {!filteredChanges.length && (
                  <div className="feature-empty">没有符合筛选条件的变化</div>
                )}
              </div>
            </aside>
          </div>

          <section className="contract-ai-panel">
            <header>
              <Sparkles size={18} />
              <div>
                <strong>AI 语义解读</strong>
                <small>只发送上方变化条款；精确比对结果不会被模型改写。</small>
              </div>
            </header>
            <div className="contract-ai-controls">
              <label>
                模型
                <select
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                >
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.providerLabel || model.provider} · {model.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                分析立场
                <select
                  value={perspective}
                  onChange={(event) =>
                    setPerspective(
                      event.target.value as ContractAnalysisPerspective,
                    )
                  }
                >
                  <option value="neutral">中立</option>
                  <option value="party-a">甲方</option>
                  <option value="party-b">乙方</option>
                </select>
              </label>
              <label>
                发送范围
                <select
                  value={contextMode}
                  onChange={(event) =>
                    setContextMode(
                      event.target.value as ContractAnalysisContext,
                    )
                  }
                >
                  <option value="changes-only">仅变化条款</option>
                  <option value="surrounding" disabled>
                    变化条款及上下文（后续支持）
                  </option>
                  <option value="full-document" disabled>
                    完整合同（后续支持）
                  </option>
                </select>
              </label>
              <button
                className="feature-primary-button"
                type="button"
                disabled={!selectedModel || analyzing}
                onClick={() => void analyze()}
              >
                {analyzing ? "正在解读…" : "生成 AI 解读"}
              </button>
            </div>
            {analysis && <div className="contract-ai-result">{analysis}</div>}
          </section>
        </>
      )}
    </div>
  );
}
