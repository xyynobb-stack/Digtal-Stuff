import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  FileDiff,
  ScanText,
  ArrowLeft,
  ChevronRight,
  BookOpen,
} from "lucide-react";

const OcrFeature = lazy(() => import("./OcrFeature"));
const ContractCompareFeature = lazy(() => import("./ContractCompareFeature"));
const ExperienceSkillFeature = lazy(() => import("./ExperienceSkillFeature"));

type FeatureId = "ocr" | "contract-compare" | "experience-skill";

interface FeatureHubProps {
  profile: string;
}

const FEATURES = [
  {
    id: "experience-skill" as const,
    title: "岗位经验沉淀",
    description:
      "填写真实工作场景，沉淀为带流程和来源的个人 SKILL，在聊天中按需选择。",
    icon: BookOpen,
  },
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
          ) : selected === "contract-compare" ? (
            <ContractCompareFeature profile={profile} />
          ) : (
            <ExperienceSkillFeature key={profile} profile={profile} />
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
          <p>选择一项本地文档工具。</p>
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
