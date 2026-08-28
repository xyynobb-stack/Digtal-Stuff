import { useState, useEffect, useCallback, useMemo } from "react";
import toast from "react-hot-toast";
import {
  Search,
  Refresh,
  Download,
  Check,
  X,
  Plus,
  Trash,
  ExternalLink,
  Puzzle,
  Bot,
  ChevronDown,
  Pencil,
  VisionIcon,
  FolderInput,
  TitleIcon as WritingTemplateIcon,
} from "../../assets/icons";
import type { LucideIcon } from "lucide-react";
import { AgentMarkdown } from "../../components/AgentMarkdown";
import { useI18n } from "../../components/useI18n";
import { OrbLoader } from "../../components/OrbLoader";
import {
  AppModal,
  AppModalDescription,
  AppModalTitle,
} from "../../components/modal/AppModal";
import type {
  RegistryKind,
  RegistryItem,
  RegistryCatalog,
  RegistryDetail,
} from "../../../../shared/registry";
import type { WritingTemplate } from "../../../../shared/writing-templates";

interface DiscoverProps {
  profile?: string;
  visible?: boolean;
  // Set by the Capabilities screen's "Browse" actions to focus a specific
  // Discover tab. The nonce changes per request so the effect re-fires even
  // when targeting the same kind twice.
  focusKind?: { kind: RegistryKind; nonce: number };
}

type DiscoverTab = "skills" | "agents" | "templates";

// @lat: [[discover#Writing templates entry]]
const KINDS: { key: DiscoverTab; icon: LucideIcon }[] = [
  { key: "skills", icon: Puzzle },
  { key: "agents", icon: Bot },
  { key: "templates", icon: WritingTemplateIcon },
];

// Per-kind setup action: distinct icon + i18n group so each card reads clearly
// (Install a skill/mcp/workflow, Create an agent profile).
const ACTION: Record<RegistryKind, { icon: LucideIcon; i18n: string }> = {
  skills: { icon: Download, i18n: "install" },
  mcps: { icon: Download, i18n: "install" },
  agents: { icon: Plus, i18n: "create" },
  workflows: { icon: Download, i18n: "install" },
};

const EMPTY: RegistryCatalog = {
  skills: [],
  mcps: [],
  agents: [],
  workflows: [],
};

type ActionState = "idle" | "working" | "done" | "error";
type TemplateModalMode = "preview" | "edit" | null;

export default function Discover({
  profile,
  visible,
  focusKind,
}: DiscoverProps): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<DiscoverTab>("skills");

  // "Browse" from the Capabilities screen focuses the matching Discover tab.
  // Guarded so normal mounts (no focus request) aren't forced.
  useEffect(() => {
    if (!focusKind) return;
    setTab(
      focusKind.kind === "skills" || focusKind.kind === "agents"
        ? focusKind.kind
        : "skills",
    );
  }, [focusKind]);
  const [catalog, setCatalog] = useState<RegistryCatalog>(EMPTY);
  // Skills shipped with the hermes-agent repo, folded into the skills list
  // alongside registry skills (deduped).
  const [bundledSkills, setBundledSkills] = useState<RegistryItem[]>([]);
  // Profile-local user skills are first-class Discover cards, but are kept
  // separate from the product-managed system catalog.
  const [userSkills, setUserSkills] = useState<RegistryItem[]>([]);
  const [systemSkillsExpanded, setSystemSkillsExpanded] = useState(true);
  const [writingTemplates, setWritingTemplates] = useState<WritingTemplate[]>(
    [],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(
    null,
  );
  const [templateModalMode, setTemplateModalMode] =
    useState<TemplateModalMode>(null);
  const [templateDescriptionDraft, setTemplateDescriptionDraft] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [installed, setInstalled] = useState<{
    skills: string[];
    mcps: string[];
    workflows: string[];
    agents: string[];
  }>({ skills: [], mcps: [], workflows: [], agents: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState<Record<string, ActionState>>({});
  const [actionError, setActionError] = useState<Record<string, string>>({});
  // Detail modal for a catalog item (preview + setup).
  const [detailItem, setDetailItem] = useState<{
    kind: RegistryKind;
    item: RegistryItem;
  } | null>(null);
  const [detailData, setDetailData] = useState<RegistryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // Confirm step before removing an installed item from the detail dialog.
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  const loadInstalled = useCallback(async () => {
    try {
      const [reg, profiles, skills, userAddedSkills] = await Promise.all([
        window.hermesAPI.listInstalledRegistry(profile),
        window.hermesAPI.listProfiles(),
        window.hermesAPI.listInstalledSkills(profile),
        window.hermesAPI.listUserAddedSkills(profile),
      ]);
      setInstalled({
        skills: [
          ...new Set([...skills, ...userAddedSkills].map((s) => s.name)),
        ],
        mcps: reg.mcps,
        workflows: reg.workflows,
        agents: profiles.map((p) => p.id),
      });
      setUserSkills(
        userAddedSkills.map((skill) => ({
          id: `local:${skill.name}`,
          name: skill.name,
          displayName: skill.displayName,
          description: skill.description,
          category: skill.category,
          path: skill.path,
        })),
      );
    } catch {
      /* leave as-is */
    }
  }, [profile]);

  const loadWritingTemplates = useCallback(async () => {
    try {
      setWritingTemplates(await window.hermesAPI.listWritingTemplates(profile));
    } catch {
      setWritingTemplates([]);
    }
  }, [profile]);

  const load = useCallback(
    async (force = false) => {
      setLoading(true);
      setError(null);
      try {
        const [data, bundled] = await Promise.all([
          window.hermesAPI.fetchRegistry(force),
          window.hermesAPI.listBundledSkills(),
        ]);
        if (data.error) setError(data.error);
        setCatalog({
          skills: data.skills ?? [],
          mcps: data.mcps ?? [],
          agents: data.agents ?? [],
          workflows: data.workflows ?? [],
        });
        // `source: name` so the existing install path runs
        // `hermes skills install <name>`.
        setBundledSkills(
          bundled.map((b) => ({
            id: b.name,
            name: b.name,
            description: b.description,
            category: b.category,
            source: b.name,
          })),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
        setCatalog(EMPTY);
      } finally {
        setLoading(false);
      }
      loadInstalled();
    },
    [loadInstalled],
  );

  // Load once on first mount, and refresh the installed-set whenever the
  // screen becomes visible (a switch elsewhere may have changed it).
  useEffect(() => {
    load();
    void loadWritingTemplates();
  }, [load, loadWritingTemplates]);

  useEffect(() => {
    if (visible) {
      loadInstalled();
      void loadWritingTemplates();
    }
  }, [visible, loadInstalled, loadWritingTemplates]);

  useEffect(() => {
    const refresh = (): void => void loadWritingTemplates();
    window.addEventListener("hermes-writing-templates-changed", refresh);
    return () =>
      window.removeEventListener("hermes-writing-templates-changed", refresh);
  }, [loadWritingTemplates]);

  // Close the detail modal on Escape.
  useEffect(() => {
    if (!detailItem) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") setDetailItem(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detailItem]);

  const isInstalled = useCallback(
    (kind: RegistryKind, item: RegistryItem): boolean => {
      switch (kind) {
        case "skills":
          return (
            installed.skills.includes(item.name) ||
            installed.skills.includes(item.id)
          );
        case "mcps":
          return installed.mcps.includes(item.id);
        case "agents":
          return installed.agents.includes(item.id);
        case "workflows":
          return installed.workflows.includes(item.id);
      }
    },
    [installed],
  );

  const matchesQuery = useCallback(
    (...fields: (string | undefined)[]): boolean => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return fields.some((f) => f && f.toLowerCase().includes(q));
    },
    [query],
  );

  // Only bundled skills belong to the system column. When the registry has a
  // matching entry, keep its richer metadata without admitting registry-only
  // community skills into the system-owned group.
  const communityList = useMemo<RegistryItem[]>(() => {
    if (tab === "templates") return [];
    const list = catalog[tab] ?? [];
    if (tab !== "skills") return list;
    const seen = new Set<string>();
    return bundledSkills.flatMap((bundled) => {
      if (seen.has(bundled.id) || seen.has(bundled.name)) return [];
      seen.add(bundled.id);
      seen.add(bundled.name);
      const registryItem = list.find(
        (item) => item.id === bundled.id || item.name === bundled.name,
      );
      return [registryItem ?? bundled];
    });
  }, [catalog, tab, bundledSkills]);

  const items = useMemo(
    () =>
      communityList.filter((i) =>
        matchesQuery(
          i.name,
          i.description,
          i.author,
          i.category,
          ...(i.tags ?? []),
        ),
      ),
    [communityList, matchesQuery],
  );

  const filteredUserSkills = useMemo(
    () =>
      userSkills.filter((skill) =>
        matchesQuery(
          skill.displayName,
          skill.name,
          skill.description,
          skill.category,
        ),
      ),
    [matchesQuery, userSkills],
  );

  // Total available skills (system + user-added, deduped) regardless of the
  // active tab or search query — tab counts always show the full catalog size.
  const skillsTotal = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const skill of [...bundledSkills, ...userSkills]) {
      if (seen.has(skill.id) || seen.has(skill.name)) continue;
      seen.add(skill.id);
      seen.add(skill.name);
      total += 1;
    }
    return total;
  }, [bundledSkills, userSkills]);

  async function handleImportLocalSkill(): Promise<void> {
    const result = await window.hermesAPI.importLocalSkill(profile);
    if (result.canceled) return;
    if (!result.success) {
      const message = result.error || "导入本地 SKILL 失败。";
      setError(message);
      toast.error(message);
      return;
    }
    setError(null);
    await loadInstalled();
    window.dispatchEvent(new Event("hermes-skills-changed"));
    toast.success(`已导入 SKILL：${result.name || "本地技能"}`);
  }

  async function handleImportWritingTemplate(): Promise<void> {
    const result = await window.hermesAPI.importWritingTemplate(profile);
    if (result.canceled) return;
    if (!result.success) {
      toast.error(result.error || "导入写作模板失败。");
      return;
    }
    await loadWritingTemplates();
    window.dispatchEvent(new Event("hermes-writing-templates-changed"));
    toast.success(`已导入写作模板：${result.template?.name || "本地模板"}`);
    setTab("templates");
    if (result.template) {
      setSelectedTemplateId(result.template.id);
      setTemplateDescriptionDraft(result.template.description ?? "");
      setTemplateModalMode("edit");
    }
  }

  const selectedTemplate =
    writingTemplates.find((template) => template.id === selectedTemplateId) ??
    null;

  function openTemplateModal(mode: Exclude<TemplateModalMode, null>): void {
    if (!selectedTemplate) return;
    setTemplateDescriptionDraft(selectedTemplate.description ?? "");
    setTemplateModalMode(mode);
  }

  async function handleSaveTemplateDescription(): Promise<void> {
    if (!selectedTemplate || templateSaving) return;
    setTemplateSaving(true);
    try {
      const updated = await window.hermesAPI.updateWritingTemplateDescription(
        selectedTemplate.id,
        templateDescriptionDraft,
        profile,
      );
      if (!updated) {
        toast.error("保存模板简介失败。");
        return;
      }
      await loadWritingTemplates();
      window.dispatchEvent(new Event("hermes-writing-templates-changed"));
      setTemplateModalMode(null);
      toast.success("模板简介已保存。");
    } finally {
      setTemplateSaving(false);
    }
  }

  async function handleReplaceTemplateFile(): Promise<void> {
    if (!selectedTemplate || templateSaving) return;
    setTemplateSaving(true);
    try {
      const result = await window.hermesAPI.replaceWritingTemplateFile(
        selectedTemplate.id,
        profile,
      );
      if (result.canceled) return;
      if (!result.success) {
        toast.error(result.error || "替换模板文件失败。");
        return;
      }
      await loadWritingTemplates();
      window.dispatchEvent(new Event("hermes-writing-templates-changed"));
      toast.success("模板文件已替换。");
    } finally {
      setTemplateSaving(false);
    }
  }

  async function handleOpenTemplate(): Promise<void> {
    if (!selectedTemplate) return;
    const opened = await window.hermesAPI.openWritingTemplate(
      selectedTemplate.id,
      profile,
    );
    if (!opened) toast.error("无法打开模板文件。");
  }

  function tabCount(key: DiscoverTab): number {
    if (key === "templates") return writingTemplates.length;
    if (key === "skills") return skillsTotal;
    return (catalog[key] ?? []).length;
  }

  async function handleInstall(
    kind: RegistryKind,
    item: RegistryItem,
  ): Promise<void> {
    const key = `${kind}:${item.id}`;
    setActions((a) => ({ ...a, [key]: "working" }));
    setActionError((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      const res = await window.hermesAPI.installRegistryItem(
        kind,
        item,
        profile,
      );
      if (res.success) {
        setActions((a) => ({ ...a, [key]: "done" }));
        await loadInstalled();
        window.dispatchEvent(new Event("hermes-skills-changed"));
      } else {
        setActions((a) => ({ ...a, [key]: "error" }));
        if (res.error) setActionError((e) => ({ ...e, [key]: res.error! }));
      }
    } catch (err) {
      setActions((a) => ({ ...a, [key]: "error" }));
      setActionError((e) => ({
        ...e,
        [key]: err instanceof Error ? err.message : "Failed",
      }));
    }
  }

  // Remove an installed item. Only MCP servers support removal today
  // (delete the server block from the active profile's config.yaml).
  async function handleUninstall(
    kind: RegistryKind,
    item: RegistryItem,
  ): Promise<void> {
    if (kind !== "mcps") return;
    const key = `${kind}:${item.id}`;
    setActions((a) => ({ ...a, [key]: "working" }));
    setActionError((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    try {
      const res = await window.hermesAPI.removeMcpServer(item.id, profile);
      if (res.success) {
        setActions((a) => ({ ...a, [key]: "idle" }));
        setConfirmUninstall(false);
        await loadInstalled();
      } else {
        setActions((a) => ({ ...a, [key]: "error" }));
        if (res.error) setActionError((e) => ({ ...e, [key]: res.error! }));
      }
    } catch (err) {
      setActions((a) => ({ ...a, [key]: "error" }));
      setActionError((e) => ({
        ...e,
        [key]: err instanceof Error ? err.message : "Failed",
      }));
    }
  }

  async function openItemDetail(
    kind: RegistryKind,
    item: RegistryItem,
  ): Promise<void> {
    setDetailItem({ kind, item });
    setDetailData(null);
    setConfirmUninstall(false);
    setDetailLoading(true);
    try {
      const detail = await window.hermesAPI.fetchRegistryDetail(kind, item);
      setDetailData(detail);
    } catch {
      setDetailData({ description: item.description });
    } finally {
      setDetailLoading(false);
    }
  }

  const ActiveIcon = KINDS.find((k) => k.key === tab)?.icon ?? Puzzle;
  const hasResults =
    tab === "skills"
      ? items.length > 0 || filteredUserSkills.length > 0
      : items.length > 0;
  const filteredWritingTemplates = writingTemplates.filter((template) =>
    `${template.name} ${template.description ?? ""} ${template.fileName} ${template.extension}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const activeRegistryKind: RegistryKind | null =
    tab === "templates" ? null : tab;

  function renderRegistryCard(
    item: RegistryItem,
    itemKind: RegistryKind,
    Icon: LucideIcon,
  ): React.JSX.Element {
    const key = `${itemKind}:${item.id}`;
    const state = actions[key] ?? "idle";
    const done = state === "done" || isInstalled(itemKind, item);
    const action = ACTION[itemKind];
    const ActionIcon = action.icon;
    const meta = [
      item.author && t("discover.by", { author: item.author }),
      item.version && `v${item.version}`,
    ].filter(Boolean);

    return (
      <div
        role="button"
        tabIndex={0}
        className="discover-card discover-card--clickable"
        onClick={() => openItemDetail(itemKind, item)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openItemDetail(itemKind, item);
          }
        }}
      >
        <div className="discover-card-head">
          <span className="discover-card-iconwrap">
            <Icon size={16} />
          </span>
          <span className="discover-card-name">
            {item.displayName || item.name}
          </span>
          {item.category && (
            <span className="discover-card-badge">{item.category}</span>
          )}
        </div>
        {meta.length > 0 && (
          <div className="discover-card-meta">{meta.join(" · ")}</div>
        )}
        <p className="discover-card-desc">{item.description}</p>
        {item.tags && item.tags.length > 0 && (
          <div className="discover-card-tags">
            {item.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="discover-tag">
                {tag}
              </span>
            ))}
          </div>
        )}
        {state === "error" && actionError[key] && (
          <div className="discover-card-error">{actionError[key]}</div>
        )}
        <div className="discover-card-footer">
          {done ? (
            <span className="discover-card-installed">
              <Check size={14} />
              {t(`discover.actions.${action.i18n}.done`)}
            </span>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm discover-install-btn"
              onClick={(event) => {
                event.stopPropagation();
                handleInstall(itemKind, item);
              }}
              disabled={state === "working"}
              title={t("discover.targetProfile")}
            >
              <ActionIcon size={14} />
              {state === "working"
                ? t(`discover.actions.${action.i18n}.working`)
                : t(`discover.actions.${action.i18n}.setup`)}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="discover-container">
      <AppModal
        open={templateModalMode !== null && selectedTemplate !== null}
        onOpenChange={(open) => {
          if (!open) setTemplateModalMode(null);
        }}
        className="writing-template-modal"
        overlayClassName="writing-template-modal-overlay"
        labelledBy="writing-template-modal-title"
        describedBy="writing-template-modal-description"
      >
        {selectedTemplate && (
          <>
            <div className="writing-template-modal-header">
              <div>
                <AppModalTitle
                  id="writing-template-modal-title"
                  className="writing-template-modal-title"
                >
                  {templateModalMode === "edit"
                    ? "修改写作模板"
                    : "预览写作模板"}
                </AppModalTitle>
                <AppModalDescription
                  id="writing-template-modal-description"
                  className="writing-template-modal-subtitle"
                >
                  {selectedTemplate.name}
                </AppModalDescription>
              </div>
              <button
                type="button"
                className="btn-ghost discover-modal-close"
                aria-label="关闭"
                onClick={() => setTemplateModalMode(null)}
              >
                <X size={18} />
              </button>
            </div>

            <div className="writing-template-modal-body">
              <div className="writing-template-preview-file">
                <WritingTemplateIcon size={24} />
                <div>
                  <strong>{selectedTemplate.fileName}</strong>
                  <span>
                    {selectedTemplate.extension.toUpperCase()} ·{" "}
                    {selectedTemplate.size} 字节
                  </span>
                </div>
              </div>

              {templateModalMode === "edit" ? (
                <label className="writing-template-description-field">
                  <span>模板简介</span>
                  <textarea
                    className="input writing-template-description-input"
                    value={templateDescriptionDraft}
                    onChange={(event) =>
                      setTemplateDescriptionDraft(event.target.value)
                    }
                    placeholder="请输入这份合同或模板的简单介绍"
                    rows={5}
                  />
                </label>
              ) : (
                <section className="writing-template-preview-description">
                  <h4>模板简介</h4>
                  <p>{selectedTemplate.description || "暂无简介"}</p>
                </section>
              )}
            </div>

            <div className="writing-template-modal-footer">
              {templateModalMode === "edit" ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void handleReplaceTemplateFile()}
                    disabled={templateSaving}
                  >
                    <FolderInput size={14} />
                    替换模板文件
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveTemplateDescription()}
                    disabled={templateSaving}
                  >
                    保存修改
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void handleOpenTemplate()}
                >
                  <ExternalLink size={14} />
                  打开模板文件
                </button>
              )}
            </div>
          </>
        )}
      </AppModal>
      {detailItem &&
        (() => {
          const { kind, item } = detailItem;
          const itemKey = `${kind}:${item.id}`;
          const itemState = actions[itemKey] ?? "idle";
          const done = itemState === "done" || isInstalled(kind, item);
          const act = ACTION[kind];
          const ActionIcon = act.icon;
          const KindIcon = KINDS.find((k) => k.key === kind)?.icon ?? Puzzle;
          return (
            <div
              className="discover-modal-overlay"
              onClick={() => setDetailItem(null)}
            >
              <div
                className="discover-modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
              >
                <div className="discover-modal-header">
                  <div className="discover-modal-titles">
                    <div className="discover-modal-name">
                      <KindIcon size={18} className="discover-card-icon" />
                      {item.displayName || item.name}
                    </div>
                    {item.category && (
                      <span className="discover-card-badge">
                        {item.category}
                      </span>
                    )}
                  </div>
                  <div className="discover-modal-actions">
                    {done ? (
                      <>
                        <span className="discover-card-installed">
                          <Check size={14} />
                          {t(`discover.actions.${act.i18n}.done`)}
                        </span>
                        {kind === "mcps" &&
                          (confirmUninstall ? (
                            <>
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => handleUninstall(kind, item)}
                                disabled={itemState === "working"}
                              >
                                <Trash size={14} />
                                {itemState === "working"
                                  ? t("discover.uninstalling")
                                  : t("discover.uninstallConfirm", {
                                      name: item.name,
                                    })}
                              </button>
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => setConfirmUninstall(false)}
                                disabled={itemState === "working"}
                              >
                                {t("common.cancel")}
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn-ghost discover-uninstall-btn"
                              onClick={() => setConfirmUninstall(true)}
                              title={t("discover.uninstall")}
                            >
                              <Trash size={14} />
                              {t("discover.uninstall")}
                            </button>
                          ))}
                      </>
                    ) : (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => handleInstall(kind, item)}
                        disabled={itemState === "working"}
                        title={t("discover.targetProfile")}
                      >
                        <ActionIcon size={14} />
                        {itemState === "working"
                          ? t(`discover.actions.${act.i18n}.working`)
                          : t(`discover.actions.${act.i18n}.setup`)}
                      </button>
                    )}
                    {item.homepage && (
                      <a
                        className="btn-ghost discover-modal-close"
                        href={item.homepage}
                        target="_blank"
                        rel="noreferrer"
                        title={t("discover.viewSource")}
                      >
                        <ExternalLink size={16} />
                      </a>
                    )}
                    <button
                      className="btn-ghost discover-modal-close"
                      onClick={() => setDetailItem(null)}
                      aria-label={t("discover.close")}
                    >
                      <X size={18} />
                    </button>
                  </div>
                </div>
                {itemState === "error" && actionError[itemKey] && (
                  <div className="discover-modal-error">
                    {actionError[itemKey]}
                  </div>
                )}
                <div className="discover-modal-content">
                  {detailLoading ? (
                    <OrbLoader state="searching" size={64} />
                  ) : (
                    <>
                      {detailData?.rows && detailData.rows.length > 0 ? (
                        <div className="discover-spec">
                          {(detailData.description || item.description) && (
                            <p className="discover-spec-lead">
                              {detailData.description || item.description}
                            </p>
                          )}
                          {detailData.rows.map((row) => (
                            <div key={row.label} className="discover-spec-row">
                              <span className="discover-spec-label">
                                {row.label}
                              </span>
                              {row.chips ? (
                                <span className="discover-spec-chips">
                                  {row.chips.map((c) => (
                                    <span key={c} className="discover-tag">
                                      {c}
                                    </span>
                                  ))}
                                </span>
                              ) : row.mono ? (
                                <code className="discover-spec-mono">
                                  {row.value}
                                </code>
                              ) : (
                                <span className="discover-spec-value">
                                  {row.value}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        !detailData?.markdown &&
                        (detailData?.description || item.description) && (
                          <p className="discover-spec-lead">
                            {detailData?.description || item.description}
                          </p>
                        )
                      )}
                      {detailData?.markdown && (
                        <div className="discover-modal-doc">
                          <AgentMarkdown>{detailData.markdown}</AgentMarkdown>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      <div className="discover-header">
        <div>
          <h1 className="discover-title">{t("discover.title")}</h1>
          <p className="discover-subtitle">{t("discover.subtitle")}</p>
        </div>
        <div className="discover-header-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            title="选择本地 SKILL.md 并导入"
            onClick={() => void handleImportLocalSkill()}
          >
            <Plus size={14} />
            导入本地 SKILL
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            title="选择本地文件作为写作模板"
            onClick={() => void handleImportWritingTemplate()}
          >
            <Plus size={14} />
            添加写作模板
          </button>
        </div>
      </div>

      <div className="discover-tabs">
        {KINDS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            className={`discover-tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            <Icon size={15} />
            {key === "templates" ? "写作模板" : t(`discover.tabs.${key}`)}
            <span className="discover-tab-count">{tabCount(key)}</span>
          </button>
        ))}
      </div>

      <div className="discover-toolbar">
        <div className="discover-search">
          <Search size={15} />
          <input
            className="discover-search-input"
            placeholder={
              tab === "templates"
                ? "搜索写作模板..."
                : t("discover.searchPlaceholder", {
                    kind: t(`discover.tabs.${tab}`).toLowerCase(),
                  })
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {tab !== "templates" && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => load(true)}
            disabled={loading}
          >
            <Refresh size={14} />
            {t("discover.refresh")}
          </button>
        )}
      </div>

      {tab === "templates" ? (
        filteredWritingTemplates.length === 0 ? (
          <div className="discover-state" data-testid="writing-templates-empty">
            <WritingTemplateIcon size={32} />
            <p className="discover-empty-title">暂无写作模板</p>
            <p className="discover-empty-text">
              点击右上角“添加写作模板”，从本地选择模板文件。
            </p>
          </div>
        ) : (
          <div className="discover-grid" data-testid="writing-templates-grid">
            {filteredWritingTemplates.map((template) => (
              <button
                type="button"
                className={`discover-card discover-card--clickable writing-template-card ${
                  selectedTemplateId === template.id ? "is-selected" : ""
                }`}
                key={template.id}
                aria-pressed={selectedTemplateId === template.id}
                onClick={() => setSelectedTemplateId(template.id)}
              >
                <div className="discover-card-head">
                  <span className="discover-card-iconwrap">
                    <WritingTemplateIcon size={16} />
                  </span>
                  <span className="discover-card-name">{template.name}</span>
                  <span className="discover-card-badge">
                    {template.extension.toUpperCase()}
                  </span>
                </div>
                {template.description && (
                  <p className="discover-card-desc">{template.description}</p>
                )}
              </button>
            ))}
          </div>
        )
      ) : loading ? (
        <div className="discover-state">
          <OrbLoader state="searching" size={64} />
        </div>
      ) : error && !hasResults ? (
        <div className="discover-state">
          <p className="discover-empty-title">{t("discover.loadError")}</p>
          <p className="discover-empty-text">{error}</p>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => load(true)}
          >
            {t("discover.retry")}
          </button>
        </div>
      ) : !hasResults ? (
        <div className="discover-state">
          <ActiveIcon size={28} />
          <p className="discover-empty-title">{t("discover.emptyTitle")}</p>
          <p className="discover-empty-text">
            {t("discover.emptyText", {
              kind: t(`discover.tabs.${tab}`).toLowerCase(),
            })}
          </p>
        </div>
      ) : tab === "skills" ? (
        <div className="discover-skill-columns">
          <section className="discover-skill-section">
            <button
              type="button"
              className="discover-skill-section-toggle"
              aria-expanded={systemSkillsExpanded}
              aria-controls="discover-system-skills"
              onClick={() => setSystemSkillsExpanded((expanded) => !expanded)}
            >
              <span>
                系统自带 SKILL
                <span className="discover-skill-section-count">
                  {items.length}
                </span>
              </span>
              <span className="discover-skill-section-toggle-label">
                {systemSkillsExpanded ? "收起全部" : "展开全部"}
                <ChevronDown
                  size={16}
                  className={systemSkillsExpanded ? "is-expanded" : ""}
                />
              </span>
            </button>
            <div
              id="discover-system-skills"
              className="discover-skill-section-list"
              hidden={!systemSkillsExpanded}
            >
              {items.length === 0 ? (
                <p className="discover-skill-section-empty">
                  没有匹配的系统技能
                </p>
              ) : (
                items.map((item) => (
                  <div key={`skills:${item.id}`}>
                    {renderRegistryCard(item, "skills", Puzzle)}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="discover-skill-section">
            <div className="discover-skill-section-heading">
              <span>
                用户添加的 SKILL
                <span className="discover-skill-section-count">
                  {filteredUserSkills.length}
                </span>
              </span>
            </div>
            <div className="discover-skill-section-list">
              {filteredUserSkills.length === 0 ? (
                <p className="discover-skill-section-empty">
                  暂无匹配的用户技能
                </p>
              ) : (
                filteredUserSkills.map((item) => (
                  <div key={`skills:${item.id}`}>
                    {renderRegistryCard(item, "skills", Puzzle)}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="discover-grid">
          {items.map((item) => {
            const itemKind = activeRegistryKind ?? "skills";
            const key = `${itemKind}:${item.id}`;
            const state = actions[key] ?? "idle";
            const done = state === "done" || isInstalled(itemKind, item);
            const action = ACTION[itemKind];
            const ActionIcon = action.icon;
            const meta = [
              item.author && t("discover.by", { author: item.author }),
              item.version && `v${item.version}`,
            ].filter(Boolean);
            return (
              <div
                key={key}
                role="button"
                tabIndex={0}
                className="discover-card discover-card--clickable"
                onClick={() => openItemDetail(itemKind, item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openItemDetail(itemKind, item);
                  }
                }}
              >
                <div className="discover-card-head">
                  <span className="discover-card-iconwrap">
                    <ActiveIcon size={16} />
                  </span>
                  <span className="discover-card-name">{item.name}</span>
                  {item.category && (
                    <span className="discover-card-badge">{item.category}</span>
                  )}
                </div>
                {meta.length > 0 && (
                  <div className="discover-card-meta">{meta.join(" · ")}</div>
                )}
                <p className="discover-card-desc">{item.description}</p>
                {item.tags && item.tags.length > 0 && (
                  <div className="discover-card-tags">
                    {item.tags.slice(0, 4).map((tg) => (
                      <span key={tg} className="discover-tag">
                        {tg}
                      </span>
                    ))}
                  </div>
                )}
                {state === "error" && actionError[key] && (
                  <div className="discover-card-error">{actionError[key]}</div>
                )}
                <div className="discover-card-footer">
                  {done ? (
                    <span className="discover-card-installed">
                      <Check size={14} />
                      {t(`discover.actions.${action.i18n}.done`)}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm discover-install-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleInstall(itemKind, item);
                      }}
                      disabled={state === "working"}
                      title={t("discover.targetProfile")}
                    >
                      <ActionIcon size={14} />
                      {state === "working"
                        ? t(`discover.actions.${action.i18n}.working`)
                        : t(`discover.actions.${action.i18n}.setup`)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {tab === "templates" && (
        <div className="writing-template-actions" aria-label="写作模板操作">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!selectedTemplate}
            onClick={() => openTemplateModal("preview")}
          >
            <VisionIcon size={15} />
            预览
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!selectedTemplate}
            onClick={() => openTemplateModal("edit")}
          >
            <Pencil size={15} />
            修改
          </button>
        </div>
      )}
    </div>
  );
}
