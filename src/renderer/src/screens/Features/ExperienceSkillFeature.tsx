import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Eye,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  SCENARIO_FIELDS,
  emptyScenario,
} from "../../../../shared/experience-skill";
import type {
  ExperiencePreview,
  ExperienceState,
  ExperienceTemplate,
} from "../../../../shared/experience-skill";
import "./experience-skill.css";

// Keep unsaved questionnaires only in this window's memory, isolated by profile.
interface ExperienceDraft {
  template: ExperienceTemplate;
  scenarioKeys: string[];
}

const drafts = new Map<string, ExperienceDraft>();
let scenarioSequence = 0;

function createScenarioKey(profile: string): string {
  scenarioSequence += 1;
  return `${profile}-scenario-${scenarioSequence}`;
}

export default function ExperienceSkillFeature({
  profile,
}: {
  profile: string;
}): React.JSX.Element {
  const [state, setState] = useState<ExperienceState | null>(null);
  const [preview, setPreview] = useState<ExperiencePreview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [scenarioKeys, setScenarioKeys] = useState<string[]>([]);
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null);
  const alive = useRef(false);
  const firstFieldRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const focusAfterDeleteKey = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    setState(null);
    setPreview(null);
    setError("");
    setPendingDeleteKey(null);
    window.hermesAPI
      .loadExperience(profile)
      .then((result) => {
        if (!cancelled) {
          const draft = drafts.get(profile);
          const template = draft?.template || result.template;
          const keys =
            draft?.scenarioKeys ||
            template.scenarios.map(() => createScenarioKey(profile));
          setScenarioKeys(keys);
          setState({
            ...result,
            template,
          });
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      alive.current = false;
    };
  }, [profile]);

  useEffect(() => {
    const key = focusAfterDeleteKey.current;
    if (!key) return;
    firstFieldRefs.current.get(key)?.focus();
    focusAfterDeleteKey.current = null;
  }, [scenarioKeys]);

  function change(
    template: ExperienceTemplate,
    nextScenarioKeys = scenarioKeys,
  ): void {
    if (!state) return;
    drafts.set(profile, { template, scenarioKeys: nextScenarioKeys });
    setScenarioKeys(nextScenarioKeys);
    setState({ ...state, template });
    setPreview(null);
    setNotice("");
    setError("");
  }
  async function generate(): Promise<void> {
    if (!state || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await window.hermesAPI.previewExperience(
        profile,
        state.template,
        state.revision,
      );
      if (alive.current) setPreview(result);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function publish(): Promise<void> {
    if (!preview || !state || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.hermesAPI.publishExperience(
        profile,
        preview.token,
      );
      // Refresh existing pickers even if the user returned to the catalog while saving.
      window.dispatchEvent(new Event("hermes-skills-changed"));
      drafts.delete(profile);
      if (alive.current) {
        setState({ ...state, revision: result.revision });
        setPreview(null);
        setNotice(
          `已保存“${preview.displayName}”。请在聊天输入框的“技能”中选择启用。`,
        );
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="experience-skill">
      <header className="feature-header">
        <div>
          <h1>岗位经验沉淀</h1>
          <p>填写真实场景 → 预览流程与来源 → 确认保存为个人 SKILL。</p>
        </div>
      </header>
      <p>
        本地规则化生成，不调用模型、不补写公司制度。请先脱敏，不填写密码、客户隐私等敏感信息。
      </p>
      {error && (
        <p role="alert" className="experience-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!state && !error && <p role="status">正在读取当前用户…</p>}
      {state && (
        <>
          <p>
            保存名称：<strong>{state.displayName}的SKILL</strong>
            。仅当前账号可选；保存不会自动为聊天启用。
          </p>
          <p>
            返回功能区会保留本窗口草稿，关闭应用前请完成预览并保存。再次保存将更新同一技能，并保留旧版本备份。
          </p>
          <fieldset disabled={busy}>
            <legend>岗位背景</legend>
            <label>
              岗位
              <input
                maxLength={6000}
                value={state.template.role}
                onChange={(e) =>
                  change({ ...state.template, role: e.target.value })
                }
                placeholder="例如：项目经理"
              />
            </label>
            <label>
              业务范围与核心职责
              <textarea
                maxLength={6000}
                value={state.template.scope}
                onChange={(e) =>
                  change({ ...state.template, scope: e.target.value })
                }
                placeholder="负责什么业务，服务哪个团队，与哪些岗位协作；经验适用范围"
              />
            </label>
          </fieldset>
          {state.template.scenarios.map((scenario, index) => (
            <fieldset
              disabled={busy}
              key={
                scenarioKeys[index] || `${profile}-scenario-fallback-${index}`
              }
            >
              <legend>场景 {index + 1}</legend>
              <p>
                除案例外均为必填。不适用的项请写明“无”及原因；每行一个步骤，并保留真实顺序。
              </p>
              {SCENARIO_FIELDS.map(([key, label, hint]) => (
                <label key={key}>
                  {label}
                  <textarea
                    ref={
                      key === "title"
                        ? (node) => {
                            const scenarioKey = scenarioKeys[index];
                            if (!scenarioKey) return;
                            if (node)
                              firstFieldRefs.current.set(scenarioKey, node);
                            else firstFieldRefs.current.delete(scenarioKey);
                          }
                        : undefined
                    }
                    rows={key === "steps" ? 6 : 3}
                    maxLength={6000}
                    value={scenario[key]}
                    placeholder={hint}
                    onChange={(e) =>
                      change({
                        ...state.template,
                        scenarios: state.template.scenarios.map((s, i) =>
                          i === index ? { ...s, [key]: e.target.value } : s,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              {state.template.scenarios.length > 1 && (
                <div className="experience-delete-zone">
                  {pendingDeleteKey === scenarioKeys[index] ? (
                    <div
                      className="experience-delete-confirm"
                      role="group"
                      aria-label={`确认删除场景 ${index + 1}`}
                    >
                      <span>
                        确定删除场景 {index + 1}？内容将从当前草稿移除。
                      </span>
                      <button
                        type="button"
                        className="btn experience-delete-cancel"
                        onClick={() => setPendingDeleteKey(null)}
                      >
                        <X size={15} />
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn experience-delete-confirm-button"
                        onClick={() => {
                          const nextKeys = scenarioKeys.filter(
                            (_, currentIndex) => currentIndex !== index,
                          );
                          focusAfterDeleteKey.current =
                            nextKeys[Math.min(index, nextKeys.length - 1)] ||
                            null;
                          change(
                            {
                              ...state.template,
                              scenarios: state.template.scenarios.filter(
                                (_, i) => i !== index,
                              ),
                            },
                            nextKeys,
                          );
                          setPendingDeleteKey(null);
                        }}
                      >
                        <Trash2 size={15} />
                        确认删除
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="btn experience-delete-button"
                      onClick={() => setPendingDeleteKey(scenarioKeys[index])}
                    >
                      <Trash2 size={15} />
                      删除此场景
                    </button>
                  )}
                </div>
              )}
            </fieldset>
          ))}
          <div className="experience-actions">
            <button
              type="button"
              className="btn experience-add-button"
              disabled={busy || state.template.scenarios.length >= 12}
              onClick={() => {
                const nextKeys = [...scenarioKeys, createScenarioKey(profile)];
                change(
                  {
                    ...state.template,
                    scenarios: [...state.template.scenarios, emptyScenario()],
                  },
                  nextKeys,
                );
              }}
            >
              <Plus size={17} />
              添加场景
            </button>
            <button
              type="button"
              className="btn experience-primary-action"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <RefreshCw className="experience-spinner" size={18} />
              ) : (
                <Sparkles size={18} />
              )}
              {busy ? "正在生成预览…" : "生成 SKILL 预览"}
            </button>
          </div>
          {preview && (
            <section
              className="experience-preview-card"
              aria-label="SKILL 预览"
            >
              <div className="experience-preview-heading">
                <span className="experience-preview-icon">
                  <Eye size={20} />
                </span>
                <div>
                  <h2>{preview.displayName}</h2>
                  <p>预览版本 · 尚未保存</p>
                </div>
              </div>
              <p>
                请核对路由、具体步骤、分支及来源。需要调整请修改上方模板并重新生成。
              </p>
              <pre className="experience-preview">{preview.markdown}</pre>
              <div className="experience-publish-footer">
                <div className="experience-publish-copy">
                  <strong>
                    {preview.replacing
                      ? "将更新已有个人技能"
                      : "准备保存个人技能"}
                  </strong>
                  <span>
                    {preview.replacing
                      ? "旧版本会自动备份，可以安全更新。"
                      : "保存后可在聊天输入框的“技能”中选择。"}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn experience-publish-action"
                  aria-label={
                    preview.replacing
                      ? "确认更新已有 SKILL"
                      : "确认保存为可选 SKILL"
                  }
                  disabled={busy}
                  onClick={() => void publish()}
                >
                  {busy ? (
                    <RefreshCw className="experience-spinner" size={18} />
                  ) : (
                    <CheckCircle2 size={18} />
                  )}
                  {preview.replacing ? "确认更新 SKILL" : "确认保存 SKILL"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
