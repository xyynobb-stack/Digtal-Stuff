import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { FileDiff, ScanText, ArrowLeft, ChevronRight } from "lucide-react";

const OcrFeature = lazy(() => import("./OcrFeature"));
const ContractCompareFeature = lazy(() => import("./ContractCompareFeature"));

type FeatureId = "ocr" | "contract-compare";

interface FeatureHubProps {
  profile: string;
}

const FEATURES = [
  {
    id: "ocr" as const,
    title: "OCR 文字识别",
    description:
      "识别图片和扫描 PDF；文字层在本地提取，扫描内容由 MinerU 精确解析。",
    icon: ScanText,
  },
  {
    id: "contract-compare" as const,
    title: "合同比对",
    description:
      "精确定位 DOCX、PDF 的条款差异，并可选择模型生成语义风险解读。",
    icon: FileDiff,
  },
];

export default function FeatureHub({
  profile,
}: FeatureHubProps): React.JSX.Element {
  const [selected, setSelected] = useState<FeatureId | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (workspaceRef.current) workspaceRef.current.scrollTop = 0;
  }, [selected]);

  if (selected) {
    return (
      <section className="feature-workspace" ref={workspaceRef}>
        <button
          className="feature-back"
          type="button"
          onClick={() => setSelected(null)}
        >
          <ArrowLeft size={16} /> 返回功能区
        </button>
        <Suspense
          fallback={<div className="feature-loading">正在加载功能…</div>}
        >
          {selected === "ocr" ? (
            <OcrFeature />
          ) : (
            <ContractCompareFeature profile={profile} />
          )}
        </Suspense>
      </section>
    );
  }

  return (
    <section className="feature-workspace" ref={workspaceRef}>
      <header className="feature-header">
        <div>
          <h1>功能区</h1>
          <p>选择一项本地文档工具。处理引擎仅在执行任务时加载。</p>
        </div>
      </header>
      <div className="feature-grid">
        {FEATURES.map((feature) => {
          const Icon = feature.icon;
          return (
            <button
              key={feature.id}
              className="feature-card"
              type="button"
              onClick={() => setSelected(feature.id)}
            >
              <span className="feature-card-icon">
                <Icon size={25} />
              </span>
              <span className="feature-card-copy">
                <strong>{feature.title}</strong>
                <small>{feature.description}</small>
              </span>
              <ChevronRight size={18} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
