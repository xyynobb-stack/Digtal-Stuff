import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Trash,
  Refresh,
  X,
  Play,
  Pause,
  Zap,
  Alert,
  Wand,
} from "../../assets/icons";
import { useI18n } from "../../components/useI18n";
import { OrbLoader } from "../../components/OrbLoader";
import type { WritingTemplate } from "../../../../shared/writing-templates";
import {
  buildReportRecommendationPrompt,
  compareDateParts,
  daysInMonth,
  requiredSkillsForTemplate,
  type DateParts,
  type ReportRecommendationType,
} from "./scheduleRecommendations";

const DELIVER_TARGETS = [
  { value: "local", label: "本地" },
  { value: "dingtalk", label: "钉钉" },
  { value: "feishu", label: "飞书" },
  { value: "wecom", label: "企业微信" },
];

interface CronJob {
  id: string;
  name: string;
  schedule: string;
  prompt: string;
  state: "active" | "paused" | "completed";
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  repeat: { times: number | null; completed: number } | null;
  deliver: string[];
  skills: string[];
  script: string | null;
  model: string | null;
  provider: string | null;
  output_dir: string | null;
}

interface ScheduleModel {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  providerLabel?: string;
}

type FrequencyType = "minutes" | "hourly" | "daily" | "weekly" | "custom";

interface SchedulesProps {
  profile?: string;
}

function toDateParts(date: Date): DateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function currentWeekRange(): { start: DateParts; end: DateParts } {
  const today = new Date();
  const mondayOffset = (today.getDay() + 6) % 7;
  const start = new Date(today);
  start.setDate(today.getDate() - mondayOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: toDateParts(start), end: toDateParts(end) };
}

interface DateDropdownsProps {
  label: string;
  value: DateParts;
  onChange: (value: DateParts) => void;
}

function DateDropdowns({
  label,
  value,
  onChange,
}: DateDropdownsProps): React.JSX.Element {
  const currentYear = new Date().getFullYear();
  const years = Array.from(
    { length: 11 },
    (_, index) => currentYear - 5 + index,
  );
  const months = Array.from({ length: 12 }, (_, index) => index + 1);
  const days = Array.from(
    { length: daysInMonth(value.year, value.month) },
    (_, index) => index + 1,
  );

  function update(next: Partial<DateParts>): void {
    const merged = { ...value, ...next };
    const maxDay = daysInMonth(merged.year, merged.month);
    onChange({ ...merged, day: Math.min(merged.day, maxDay) });
  }

  return (
    <div className="schedules-field">
      <label className="schedules-field-label">{label}</label>
      <div className="schedules-date-dropdowns">
        <select
          className="input"
          aria-label={`${label}年份`}
          value={value.year}
          onChange={(event) => update({ year: Number(event.target.value) })}
        >
          {years.map((year) => (
            <option key={year} value={year}>
              {year} 年
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label={`${label}月份`}
          value={value.month}
          onChange={(event) => update({ month: Number(event.target.value) })}
        >
          {months.map((month) => (
            <option key={month} value={month}>
              {month} 月
            </option>
          ))}
        </select>
        <select
          className="input"
          aria-label={`${label}日期`}
          value={value.day}
          onChange={(event) => update({ day: Number(event.target.value) })}
        >
          {days.map((day) => (
            <option key={day} value={day}>
              {day} 日
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Schedules({ profile }: SchedulesProps): React.JSX.Element {
  const { t } = useI18n();
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [recommendationMenuOpen, setRecommendationMenuOpen] = useState(false);
  const [recommendationType, setRecommendationType] =
    useState<ReportRecommendationType | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Create form state
  const [newName, setNewName] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newDeliver, setNewDeliver] = useState("local");
  const [availableModels, setAvailableModels] = useState<ScheduleModel[]>([]);
  const [newModelId, setNewModelId] = useState("");
  const [writingTemplates, setWritingTemplates] = useState<WritingTemplate[]>(
    [],
  );
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [employeeName, setEmployeeName] = useState("");
  const [workContent, setWorkContent] = useState("");
  const todayParts = toDateParts(new Date());
  const initialWeek = currentWeekRange();
  const [reportStartDate, setReportStartDate] = useState<DateParts>(todayParts);
  const [reportEndDate, setReportEndDate] = useState<DateParts>(
    initialWeek.end,
  );

  //Local显示具体路径
  const [localOutputDir, setLocalOutputDir] = useState("");
  const [newOutputDir, setNewOutputDir] = useState<string | null>(null);

  // Schedule builder state
  const [frequency, setFrequency] = useState<FrequencyType>("daily");
  const [minutesInterval, setMinutesInterval] = useState("30");
  const [hourlyInterval, setHourlyInterval] = useState("1");
  const [dailyTime, setDailyTime] = useState("09:00");
  const [weeklyDay, setWeeklyDay] = useState("1");
  const [weeklyTime, setWeeklyTime] = useState("09:00");
  const [customCron, setCustomCron] = useState("");

  useEffect(() => {
    window.hermesAPI
      .getHermesHome(profile)
      .then((home) => {
        const separator = home.includes("\\") ? "\\" : "/";
        const normalizedHome = home.replace(/[\\/]+$/, "");

        setLocalOutputDir(
          `${normalizedHome}${separator}cron${separator}output`,
        );
      })
      .catch(() => {
        setLocalOutputDir("");
      });
  }, [profile]);

  const loadJobs = useCallback(async (): Promise<void> => {
    try {
      const list = await window.hermesAPI.listCronJobs(true, profile);
      setJobs(list);
    } catch {
      setError(t("schedules.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [profile, t]);

  const loadModels = useCallback(async (): Promise<void> => {
    try {
      const [savedModels, configured] = await Promise.all([
        window.hermesAPI.listModels(),
        window.hermesAPI.getModelConfig(profile),
      ]);
      setAvailableModels(savedModels);
      const normalizeUrl = (value: string): string =>
        value.trim().replace(/\/+$/, "");
      const configuredCandidates = savedModels.filter(
        (candidate) =>
          candidate.provider === configured.provider &&
          candidate.model === configured.model,
      );
      const configuredModel =
        configuredCandidates.find(
          (candidate) =>
            normalizeUrl(candidate.baseUrl) ===
            normalizeUrl(configured.baseUrl),
        ) || configuredCandidates[0];
      setNewModelId((current) =>
        savedModels.some((candidate) => candidate.id === current)
          ? current
          : configuredModel?.id || savedModels[0]?.id || "",
      );
    } catch {
      setAvailableModels([]);
      setNewModelId("");
    }
  }, [profile]);

  useEffect(() => {
    loadJobs();
    loadModels();
  }, [loadJobs, loadModels]);

  useEffect(() => {
    window.hermesAPI
      .listWritingTemplates(profile)
      .then((templates) => {
        setWritingTemplates(templates);
        setSelectedTemplateId((current) =>
          templates.some((template) => template.id === current)
            ? current
            : templates[0]?.id || "",
        );
      })
      .catch(() => {
        setWritingTemplates([]);
        setSelectedTemplateId("");
      });
  }, [profile]);

  // Escape key to close modals
  useEffect(() => {
    if (!showCreate && !confirmDelete && !recommendationMenuOpen) return;
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        if (confirmDelete) setConfirmDelete(null);
        else if (showCreate) setShowCreate(false);
        else setRecommendationMenuOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [showCreate, confirmDelete, recommendationMenuOpen]);

  function resetForm(): void {
    setNewName("");
    setNewPrompt("");
    setNewDeliver("local");
    setNewOutputDir(null);
    setFrequency("daily");
    setMinutesInterval("30");
    setHourlyInterval("1");
    setDailyTime("09:00");
    setWeeklyDay("1");
    setWeeklyTime("09:00");
    setCustomCron("");
    setRecommendationType(null);
    setEmployeeName("");
    setWorkContent("");
    setReportStartDate(toDateParts(new Date()));
    setReportEndDate(currentWeekRange().end);
  }

  function closeCreateModal(): void {
    setShowCreate(false);
    resetForm();
  }

  function openRecommendedTask(type: ReportRecommendationType): void {
    const week = currentWeekRange();
    setRecommendationMenuOpen(false);
    setRecommendationType(type);
    setNewName(type === "weekly-report" ? "周报汇总" : "日报汇总");
    setNewPrompt("");
    setFrequency(type === "weekly-report" ? "weekly" : "daily");
    setReportStartDate(
      type === "weekly-report" ? week.start : toDateParts(new Date()),
    );
    setReportEndDate(week.end);
    setShowCreate(true);
  }

  function buildSchedule(): string {
    switch (frequency) {
      case "minutes":
        return `${minutesInterval}m`;
      case "hourly":
        return `${hourlyInterval}h`;
      case "daily": {
        const [h, m] = dailyTime.split(":");
        return `${m} ${h} * * *`;
      }
      case "weekly": {
        const [h, m] = weeklyTime.split(":");
        return `${m} ${h} * * ${weeklyDay}`;
      }
      case "custom":
        return customCron.trim();
    }
  }

  function isScheduleValid(): boolean {
    if (frequency === "custom") return customCron.trim().length > 0;
    if (frequency === "minutes") return parseInt(minutesInterval) > 0;
    if (frequency === "hourly") return parseInt(hourlyInterval) > 0;
    return true;
  }

  const selectedTemplate = writingTemplates.find(
    (template) => template.id === selectedTemplateId,
  );
  const reportDateRangeValid =
    recommendationType !== "weekly-report" ||
    compareDateParts(reportEndDate, reportStartDate) >= 0;
  const recommendationFieldsValid =
    recommendationType === null ||
    Boolean(
      selectedTemplate &&
      employeeName.trim() &&
      workContent.trim() &&
      reportDateRangeValid,
    );

  async function handleCreate(): Promise<void> {
    const selectedModel = availableModels.find(
      (candidate) => candidate.id === newModelId,
    );
    if (!isScheduleValid() || !selectedModel || !recommendationFieldsValid)
      return;
    const taskPrompt =
      recommendationType && selectedTemplate
        ? buildReportRecommendationPrompt({
            type: recommendationType,
            employeeName,
            workContent,
            startDate: reportStartDate,
            ...(recommendationType === "weekly-report"
              ? { endDate: reportEndDate }
              : {}),
            template: selectedTemplate,
          })
        : newPrompt.trim() || undefined;
    setActionInProgress("creating");
    setError("");
    try {
      const result = await window.hermesAPI.createCronJob(
        buildSchedule(),
        taskPrompt,
        newName.trim() || undefined,
        newDeliver !== "local" ? newDeliver : undefined,
        profile,
        selectedModel.model,
        selectedModel.provider,
        newDeliver === "local" ? newOutputDir || undefined : undefined,
        recommendationType && selectedTemplate
          ? requiredSkillsForTemplate(selectedTemplate)
          : undefined,
      );
      if (result.success) {
        closeCreateModal();
        await loadJobs();
      } else {
        setError(result.error || "Failed to create job");
      }
    } catch {
      setError("Failed to create job");
    } finally {
      setActionInProgress(null);
    }
  }

  async function handlePickOutputDirectory(): Promise<void> {
    const selected = await window.hermesAPI.selectFolder();
    if (selected) setNewOutputDir(selected);
  }

  async function handleRemove(jobId: string): Promise<void> {
    setActionInProgress(jobId);
    setError("");
    try {
      const result = await window.hermesAPI.removeCronJob(jobId, profile);
      setConfirmDelete(null);
      if (result.success) {
        await loadJobs();
      } else {
        setError(result.error || "Failed to remove job");
      }
    } catch {
      setError("Failed to remove job");
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleToggle(job: CronJob): Promise<void> {
    setActionInProgress(job.id);
    setError("");
    try {
      const result =
        job.state === "paused"
          ? await window.hermesAPI.resumeCronJob(job.id, profile)
          : await window.hermesAPI.pauseCronJob(job.id, profile);
      if (result.success) {
        await loadJobs();
      } else {
        setError(result.error || "Failed to update job");
      }
    } catch {
      setError("Failed to update job");
    } finally {
      setActionInProgress(null);
    }
  }

  async function handleTrigger(job: CronJob): Promise<void> {
    const fallbackModel = availableModels.find(
      (candidate) => candidate.id === newModelId,
    );
    if (!job.model && !fallbackModel) {
      setError(t("schedules.noModels"));
      return;
    }
    setActionInProgress(job.id);
    setError("");
    try {
      const result = await window.hermesAPI.triggerCronJob(
        job.id,
        profile,
        job.model ? undefined : fallbackModel?.model,
        job.model ? undefined : fallbackModel?.provider,
      );
      if (result.success) {
        await loadJobs();
      } else {
        setError(result.error || "Failed to trigger job");
      }
    } catch {
      setError("Failed to trigger job");
    } finally {
      setActionInProgress(null);
    }
  }

  function formatTime(iso: string | null): string {
    if (!iso) return "--";
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  if (loading) {
    return (
      <div className="schedules-container">
        <div className="schedules-loading">
          <OrbLoader state="searching" size={64} />
        </div>
      </div>
    );
  }

  return (
    <div className="schedules-container">
      {/* Create Modal */}
      {showCreate && (
        <div className="skills-detail-overlay" onClick={closeCreateModal}>
          <div className="schedules-modal" onClick={(e) => e.stopPropagation()}>
            <div className="schedules-modal-header">
              <h3>{t("schedules.newTask")}</h3>
              <button className="btn-ghost" onClick={closeCreateModal}>
                <X size={18} />
              </button>
            </div>
            <div className="schedules-modal-body">
              <div className="schedules-field">
                <label className="schedules-field-label">
                  {t("schedules.name")}
                </label>
                <input
                  className="input"
                  type="text"
                  placeholder={t("schedules.namePlaceholder")}
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </div>
              {recommendationType && (
                <div className="schedules-recommendation-fields">
                  <div className="schedules-recommendation-banner">
                    <Wand size={16} />
                    <div>
                      <strong>
                        {recommendationType === "weekly-report"
                          ? "周报汇总"
                          : "日报汇总"}
                      </strong>
                      <span>
                        模型将在任务执行时读取所选模板，并把以下内容整理为成品文件。
                      </span>
                    </div>
                  </div>
                  <div className="schedules-field">
                    <label className="schedules-field-label">
                      写作模板 <span className="schedules-required">*</span>
                    </label>
                    <select
                      className="input"
                      value={selectedTemplateId}
                      onChange={(event) =>
                        setSelectedTemplateId(event.target.value)
                      }
                      disabled={writingTemplates.length === 0}
                    >
                      {writingTemplates.length === 0 ? (
                        <option value="">暂无写作模板，请先在发现中添加</option>
                      ) : (
                        writingTemplates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name} ({template.extension.toUpperCase()})
                          </option>
                        ))
                      )}
                    </select>
                    {selectedTemplate?.description && (
                      <div className="schedules-field-hint">
                        {selectedTemplate.description}
                      </div>
                    )}
                  </div>
                  <div className="schedules-field">
                    <label className="schedules-field-label">
                      姓名 <span className="schedules-required">*</span>
                    </label>
                    <input
                      className="input"
                      type="text"
                      placeholder="请输入姓名"
                      value={employeeName}
                      onChange={(event) => setEmployeeName(event.target.value)}
                    />
                  </div>
                  <div className="schedules-field">
                    <label className="schedules-field-label">
                      工作内容 <span className="schedules-required">*</span>
                    </label>
                    <textarea
                      className="input schedules-textarea schedules-report-content"
                      placeholder="请输入需要汇总的工作事项、进展、成果和问题"
                      value={workContent}
                      onChange={(event) => setWorkContent(event.target.value)}
                      rows={5}
                    />
                  </div>
                  <div
                    className={`schedules-report-dates ${
                      recommendationType === "weekly-report" ? "is-range" : ""
                    }`}
                  >
                    <DateDropdowns
                      label={
                        recommendationType === "weekly-report"
                          ? "本周起始日期"
                          : "工作日期"
                      }
                      value={reportStartDate}
                      onChange={setReportStartDate}
                    />
                    {recommendationType === "weekly-report" && (
                      <DateDropdowns
                        label="本周结束日期"
                        value={reportEndDate}
                        onChange={setReportEndDate}
                      />
                    )}
                  </div>
                  {!reportDateRangeValid && (
                    <div className="schedules-validation-error" role="alert">
                      本周结束日期不能早于本周起始日期。
                    </div>
                  )}
                </div>
              )}
              <div className="schedules-field">
                <label className="schedules-field-label">
                  {t("schedules.frequency")}{" "}
                  <span className="schedules-required">*</span>
                </label>
                <div className="schedules-freq-pills">
                  {(
                    [
                      ["minutes", t("schedules.frequencyMinutes")],
                      ["hourly", t("schedules.frequencyHourly")],
                      ["daily", t("schedules.frequencyDaily")],
                      ["weekly", t("schedules.frequencyWeekly")],
                      ["custom", t("schedules.frequencyCustom")],
                    ] as const
                  ).map(([val, label]) => (
                    <button
                      key={val}
                      type="button"
                      className={`schedules-freq-pill ${frequency === val ? "active" : ""}`}
                      onClick={() => setFrequency(val)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {frequency === "minutes" && (
                <div className="schedules-field">
                  <label className="schedules-field-label">
                    {t("schedules.minutesInterval")}
                  </label>
                  <select
                    className="input"
                    value={minutesInterval}
                    onChange={(e) => setMinutesInterval(e.target.value)}
                  >
                    {["5", "10", "15", "30", "45"].map((v) => (
                      <option key={v} value={v}>
                        {t("schedules.everyNMinutes", { n: v })}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {frequency === "hourly" && (
                <div className="schedules-field">
                  <label className="schedules-field-label">
                    {t("schedules.hoursInterval")}
                  </label>
                  <select
                    className="input"
                    value={hourlyInterval}
                    onChange={(e) => setHourlyInterval(e.target.value)}
                  >
                    {["1", "2", "3", "4", "6", "8", "12"].map((v) => (
                      <option key={v} value={v}>
                        {t("schedules.everyNHours", { n: v })}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {frequency === "daily" && (
                <div className="schedules-field">
                  <label className="schedules-field-label">
                    {t("schedules.executionTime")}
                  </label>
                  <input
                    className="input"
                    type="time"
                    value={dailyTime}
                    onChange={(e) => setDailyTime(e.target.value)}
                  />
                </div>
              )}

              {frequency === "weekly" && (
                <>
                  <div className="schedules-field">
                    <label className="schedules-field-label">
                      {t("schedules.weekday")}
                    </label>
                    <select
                      className="input"
                      value={weeklyDay}
                      onChange={(e) => setWeeklyDay(e.target.value)}
                    >
                      {[
                        ["1", t("schedules.monday")],
                        ["2", t("schedules.tuesday")],
                        ["3", t("schedules.wednesday")],
                        ["4", t("schedules.thursday")],
                        ["5", t("schedules.friday")],
                        ["6", t("schedules.saturday")],
                        ["0", t("schedules.sunday")],
                      ].map(([val, label]) => (
                        <option key={val} value={val}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="schedules-field">
                    <label className="schedules-field-label">
                      {t("schedules.executionTime")}
                    </label>
                    <input
                      className="input"
                      type="time"
                      value={weeklyTime}
                      onChange={(e) => setWeeklyTime(e.target.value)}
                    />
                  </div>
                </>
              )}

              {frequency === "custom" && (
                <div className="schedules-field">
                  <label className="schedules-field-label">
                    {t("schedules.cronExpression")}
                  </label>
                  <input
                    className="input"
                    type="text"
                    placeholder={t("schedules.cronPlaceholder")}
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                  />
                  <div className="schedules-field-hint">
                    {t("schedules.cronHint")}
                  </div>
                </div>
              )}
              {!recommendationType && (
                <div className="schedules-field">
                  <label className="schedules-field-label">
                    {t("schedules.prompt")}
                  </label>
                  <textarea
                    className="input schedules-textarea"
                    placeholder={t("schedules.promptPlaceholder")}
                    value={newPrompt}
                    onChange={(e) => setNewPrompt(e.target.value)}
                    rows={3}
                  />
                </div>
              )}
              <div className="schedules-field">
                <label className="schedules-field-label">
                  {t("schedules.deliverTo")}
                </label>
                <select
                  className="input"
                  value={newDeliver}
                  onChange={(e) => setNewDeliver(e.target.value)}
                >
                  {DELIVER_TARGETS.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                {newDeliver === "local" && (
                  <div className="schedules-output-directory">
                    <div className="schedules-output-directory-path">
                      <span>本地结果保存目录</span>
                      <strong title={newOutputDir || localOutputDir}>
                        {newOutputDir || localOutputDir || "正在读取目录……"}
                      </strong>
                    </div>
                    <div className="schedules-output-directory-actions">
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => void handlePickOutputDirectory()}
                      >
                        选择目录
                      </button>
                      {newOutputDir && (
                        <button
                          className="btn btn-secondary"
                          type="button"
                          onClick={() => setNewOutputDir(null)}
                        >
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="schedules-field">
                <label className="schedules-field-label">
                  {t("schedules.model")}{" "}
                  <span className="schedules-required">*</span>
                </label>
                <select
                  className="input"
                  value={newModelId}
                  onChange={(e) => setNewModelId(e.target.value)}
                  disabled={availableModels.length === 0}
                >
                  {availableModels.length === 0 ? (
                    <option value="">{t("schedules.noModels")}</option>
                  ) : (
                    availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name} ({model.providerLabel || model.provider})
                      </option>
                    ))
                  )}
                </select>
                <div className="schedules-field-hint">
                  {t("schedules.modelHint")}
                </div>
              </div>
            </div>
            <div className="schedules-modal-footer">
              <button className="btn btn-secondary" onClick={closeCreateModal}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleCreate}
                disabled={
                  !isScheduleValid() ||
                  !newModelId ||
                  !recommendationFieldsValid ||
                  actionInProgress === "creating"
                }
              >
                {actionInProgress === "creating"
                  ? t("schedules.creating")
                  : t("schedules.create")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          className="skills-detail-overlay"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="schedules-modal schedules-modal-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="schedules-modal-header">
              <h3>{t("schedules.deleteTaskTitle")}</h3>
              <button
                className="btn-ghost"
                onClick={() => setConfirmDelete(null)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="schedules-modal-body">
              <p className="schedules-confirm-text">
                {t("schedules.deleteConfirmText")}
              </p>
            </div>
            <div className="schedules-modal-footer">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setConfirmDelete(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-danger btn-sm"
                onClick={() => handleRemove(confirmDelete)}
                disabled={actionInProgress === confirmDelete}
              >
                {actionInProgress === confirmDelete
                  ? t("schedules.deleting")
                  : t("schedules.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="schedules-header">
        <div>
          <h2 className="schedules-title">{t("schedules.title")}</h2>
          <p className="schedules-subtitle">{t("schedules.subtitle")}</p>
        </div>
        <div className="schedules-header-actions">
          <div className="schedules-recommendation-trigger">
            <button
              className="btn btn-secondary"
              type="button"
              aria-haspopup="menu"
              aria-expanded={recommendationMenuOpen}
              onClick={() => setRecommendationMenuOpen((current) => !current)}
            >
              <Wand size={14} />
              计划推荐
            </button>
            {recommendationMenuOpen && (
              <div
                className="schedules-recommendation-menu"
                role="menu"
                aria-label="计划推荐"
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openRecommendedTask("weekly-report")}
                >
                  <strong>周报汇总</strong>
                  <span>按起止日期汇总工作并生成周报</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => openRecommendedTask("daily-report")}
                >
                  <strong>日报汇总</strong>
                  <span>按单个工作日期整理并生成日报</span>
                </button>
              </div>
            )}
          </div>
          <button className="btn btn-secondary" onClick={loadJobs}>
            <Refresh size={14} />
            {t("schedules.refresh")}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setShowCreate(true)}
          >
            <Plus size={14} />
            {t("schedules.newTask")}
          </button>
        </div>
      </div>

      {error && (
        <div className="skills-error">
          {error}
          <button className="btn-ghost" onClick={() => setError("")}>
            <X size={14} />
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="schedules-empty">
          <p className="schedules-empty-text">{t("schedules.empty")}</p>
          <p className="schedules-empty-hint">{t("schedules.emptyHint")}</p>
          <button
            className="btn btn-primary"
            style={{ marginTop: 12 }}
            onClick={() => setShowCreate(true)}
          >
            <Plus size={14} />
            {t("schedules.firstTask")}
          </button>
        </div>
      ) : (
        <div className="schedules-list">
          {jobs.map((job) => (
            <div key={job.id} className="schedules-card">
              <div className="schedules-card-top">
                <div className="schedules-card-info">
                  <div className="schedules-card-name">{job.name}</div>
                  <div className="schedules-card-schedule">{job.schedule}</div>
                </div>
                <div className="schedules-card-actions">
                  <span
                    className={`schedules-badge schedules-badge-${job.state}`}
                  >
                    {job.state === "active"
                      ? t("schedules.active")
                      : job.state === "paused"
                        ? t("schedules.paused")
                        : t("schedules.completed")}
                  </span>
                  {job.state !== "completed" && (
                    <button
                      className="btn-ghost schedules-action-btn"
                      data-tooltip={
                        job.state === "paused"
                          ? t("schedules.resume")
                          : t("schedules.pause")
                      }
                      onClick={() => handleToggle(job)}
                      disabled={actionInProgress === job.id}
                    >
                      {job.state === "paused" ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                    </button>
                  )}
                  {job.state === "active" && (
                    <button
                      className="btn-ghost schedules-action-btn"
                      data-tooltip={t("schedules.triggerNow")}
                      onClick={() => handleTrigger(job)}
                      disabled={actionInProgress === job.id}
                    >
                      <Zap size={14} />
                    </button>
                  )}
                  <button
                    className="btn-ghost schedules-action-btn schedules-action-danger"
                    data-tooltip={t("schedules.delete")}
                    onClick={() => setConfirmDelete(job.id)}
                    disabled={actionInProgress === job.id}
                  >
                    <Trash size={14} />
                  </button>
                </div>
              </div>

              {job.prompt && (
                <div className="schedules-card-prompt">{job.prompt}</div>
              )}

              <div className="schedules-card-meta">
                {job.model && (
                  <span>
                    {t("schedules.model")}: {job.model}
                  </span>
                )}
                <span>
                  {t("schedules.nextRun")}: {formatTime(job.next_run_at)}
                </span>
                {job.last_run_at && (
                  <span>
                    {t("schedules.lastRun")}: {formatTime(job.last_run_at)}
                    {job.last_status && job.last_status !== "ok" && (
                      <span className="schedules-card-error-icon">
                        <Alert size={12} />
                      </span>
                    )}
                  </span>
                )}
                {job.repeat && job.repeat.times && (
                  <span>
                    {t("schedules.runCount")}: {job.repeat.completed}/
                    {job.repeat.times}
                  </span>
                )}
                {job.deliver.length > 0 &&
                  !(job.deliver.length === 1 && job.deliver[0] === "local") && (
                    <span>
                      {t("schedules.deliveredTo")}: {job.deliver.join(", ")}
                    </span>
                  )}
                {job.skills.length > 0 && (
                  <span>
                    {t("schedules.skills")}: {job.skills.join(", ")}
                  </span>
                )}
                {job.output_dir && (
                  <span title={job.output_dir}>
                    本地输出目录：{job.output_dir}
                  </span>
                )}
              </div>

              {job.last_error && (
                <div className="schedules-card-error">{job.last_error}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Schedules;
