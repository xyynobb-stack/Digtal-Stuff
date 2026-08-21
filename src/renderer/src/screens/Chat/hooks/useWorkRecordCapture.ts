import { useEffect, useReducer, useRef } from "react";
import type { ChatMessage, ChatBubbleMessage, ToolCallMessage } from "../types";
import type {
  WorkRecordAttachment,
  WorkRecordSnapshot,
  WorkRecordStep,
  WorkRecordType,
} from "../../../../../shared/work-records";

interface TurnContext {
  profileId: string;
  profileName: string;
  sessionId?: string;
  skills: string[];
  template: boolean;
  contextFolder: boolean;
  createdAt: number;
}

interface CaptureOptions {
  messages: ChatMessage[];
  profileId: string;
  profileName: string;
  sessionId: string | null;
  skills: string[];
  template: boolean;
  contextFolder: string | null;
  isLoading: boolean;
  enrichWorkRecord?: (
    input: WorkRecordEnrichmentInput,
  ) => Promise<string | null>;
}

export interface WorkRecordEnrichmentInput {
  prompt: string;
  attachments: string[];
  actions: string[];
  result: string;
}

interface WorkRecordEnrichment {
  title: string;
  steps: string[];
}

const QUICK_ACTIONS: Array<[RegExp, string, WorkRecordType]> = [
  [
    /(?:写|生成|整理|制作).{0,8}(?:工作)?周报|(?:工作)?周报.{0,8}(?:写|生成|整理|制作)/u,
    "帮我写周报",
    "document",
  ],
  [/(汇总|合并).{0,6}(报表|表格)/, "汇总多份报表", "analysis"],
  [/(提取|读取).{0,8}(文件|文档).{0,4}(信息|内容)/, "提取文件信息", "document"],
  [/(查资料|搜索|检索).{0,10}(对比|比较)/, "查资料做对比", "research"],
  [/(设置|创建).{0,8}(提醒|定时)/, "设置定时提醒", "reminder"],
  [/(整理|生成).{0,8}会议纪要/, "整理会议纪要", "document"],
];

function bubble(message: ChatMessage): ChatBubbleMessage | null {
  return "content" in message &&
    (message.role === "user" || message.role === "agent")
    ? (message as ChatBubbleMessage)
    : null;
}

export function deriveWorkRecordTitle(
  prompt: string,
  attachments: WorkRecordAttachment[],
): { title: string; type: WorkRecordType } {
  const normalized = prompt
    .replace(/^\s*（如需使用模板[^）]*）/u, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [pattern, title, type] of QUICK_ACTIONS) {
    if (pattern.test(normalized)) return { title, type };
  }
  let title = normalized
    .replace(/^(请|麻烦|请你|请帮我|帮我|能否|可以帮我)\s*/u, "")
    .split(/[。！？!?\n]/u)[0]
    .trim();
  if (
    (!title || /^(看看|处理一下|分析一下|这个|这些)$/u.test(title)) &&
    attachments.length
  ) {
    title = `处理${attachments[0].name}`;
  }
  if (!title)
    title = attachments.length ? `处理${attachments[0].name}` : "未命名工作";
  const type: WorkRecordType = /提醒|定时/u.test(normalized)
    ? "reminder"
    : /搜索|检索|查找|对比|比较/u.test(normalized)
      ? "research"
      : attachments.length
        ? "document"
        : "general";
  return { title: title.slice(0, 32), type };
}

function isWorkPrompt(prompt: string): boolean {
  return /(写|整理|汇总|提取|读取|分析|对比|比较|搜索|检索|查找|生成|导出|创建|设置|提醒|修改|制作|总结|统计|转换|翻译|发送)/u.test(
    prompt,
  );
}

function collectAttachments(messages: ChatMessage[]): WorkRecordAttachment[] {
  const seen = new Set<string>();
  const result: WorkRecordAttachment[] = [];
  for (const message of messages) {
    const attachments =
      "attachments" in message ? message.attachments : undefined;
    for (const attachment of attachments ?? []) {
      const key = `${attachment.path ?? ""}|${attachment.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        name: attachment.name,
        kind: attachment.kind,
        path: attachment.path,
        size: attachment.size,
      });
    }
  }
  return result;
}

function toolLabel(name: string): string {
  const lower = name.toLocaleLowerCase();
  if (/(read|open|extract)/.test(lower)) return "读取来源文件";
  if (/(write|create|export|save)/.test(lower)) return "生成并保存结果";
  if (/(search|browser|web)/.test(lower)) return "检索并整理资料";
  if (/(cron|schedule|remind)/.test(lower)) return "创建定时任务";
  if (/(code|python|shell|terminal|exec)/.test(lower)) return "处理并分析内容";
  return "处理任务内容";
}

function collectActionLabels(messages: ChatMessage[]): string[] {
  const labels: string[] = [];
  for (const message of messages) {
    if (message.kind !== "tool_call") continue;
    const label = toolLabel((message as ToolCallMessage).name);
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

function collectFallbackSteps(
  messages: ChatMessage[],
  attachments: WorkRecordAttachment[],
  hasResult: boolean,
): WorkRecordStep[] {
  const labels: string[] = [];
  if (attachments.length > 0) {
    labels.push(
      attachments.length === 1
        ? `读取附件“${attachments[0].name}”`
        : `读取 ${attachments.length} 个附件`,
    );
  }
  for (const label of collectActionLabels(messages)) {
    if (!labels.includes(label)) labels.push(label);
  }
  if (hasResult) labels.push("整理并返回处理结果");
  if (labels.length === 0) labels.push("处理你的请求");
  return labels.slice(0, 5).map((label, position) => ({
    id: `local-${position}`,
    name: "business-step",
    label,
    status: "completed",
    position,
  }));
}

export function parseWorkRecordEnrichment(
  text: string | null | undefined,
): WorkRecordEnrichment | null {
  if (!text?.trim()) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as {
      title?: unknown;
      steps?: unknown;
    };
    const title =
      typeof value.title === "string"
        ? value.title.replace(/\s+/g, " ").trim().slice(0, 80)
        : "";
    const steps = Array.isArray(value.steps)
      ? value.steps
          .filter((step): step is string => typeof step === "string")
          .map((step) => step.replace(/\s+/g, " ").trim().slice(0, 80))
          .filter((step, index, all) => step && all.indexOf(step) === index)
          .slice(0, 5)
      : [];
    return title && steps.length > 0 ? { title, steps } : null;
  } catch {
    return null;
  }
}

export function buildWorkRecordSnapshot(
  turnId: string,
  turnMessages: ChatMessage[],
  context: TurnContext,
  revision: number,
  isLatestLoading: boolean,
): WorkRecordSnapshot | null {
  const user = turnMessages
    .map(bubble)
    .find((message) => message?.role === "user");
  if (!user) return null;
  const attachments = collectAttachments(turnMessages);
  const prompt = user.content.trim();
  const agents = turnMessages
    .map(bubble)
    .filter((message): message is ChatBubbleMessage =>
      Boolean(message && message.role === "agent"),
    );
  const resultSummary = [...agents]
    .reverse()
    .find((message) => message.content.trim())
    ?.content.trim()
    .slice(0, 4000);
  const steps = collectFallbackSteps(
    turnMessages,
    attachments,
    Boolean(resultSummary),
  );
  const actionLabels = collectActionLabels(turnMessages);
  const qualifies =
    attachments.length > 0 ||
    actionLabels.length > 0 ||
    context.skills.length > 0 ||
    context.template ||
    context.contextFolder ||
    QUICK_ACTIONS.some(([pattern]) => pattern.test(prompt)) ||
    isWorkPrompt(prompt);
  if (!qualifies) return null;
  const failed = agents.some((message) => Boolean(message.error));
  const status = failed
    ? "failed"
    : isLatestLoading
      ? "running"
      : agents.length || steps.length
        ? "completed"
        : "interrupted";
  const { title, type } = deriveWorkRecordTitle(prompt, attachments);
  const now = Date.now();
  return {
    id: turnId,
    revision,
    profileId: context.profileId,
    profileName: context.profileName,
    sessionId: context.sessionId,
    title,
    type,
    status,
    prompt,
    resultSummary,
    createdAt: context.createdAt,
    updatedAt: now,
    completedAt:
      status === "completed" || status === "failed" ? now : undefined,
    attachments,
    steps,
  };
}

export function useWorkRecordCapture(options: CaptureOptions): void {
  const contexts = useRef(new Map<string, TurnContext>());
  const fingerprints = useRef(new Map<string, string>());
  const revisions = useRef(new Map<string, number>());
  const enrichmentRequests = useRef(new Map<string, string>());
  const enrichmentEligible = useRef(new Set<string>());
  const enrichments = useRef(
    new Map<string, { key: string; value: WorkRecordEnrichment }>(),
  );
  const mounted = useRef(true);
  const [enrichmentEpoch, refreshEnrichments] = useReducer(
    (value: number) => value + 1,
    0,
  );

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    const turns: Array<{ id: string; messages: ChatMessage[] }> = [];
    let current: { id: string; messages: ChatMessage[] } | null = null;
    for (const message of options.messages) {
      const asBubble = bubble(message);
      if (asBubble?.role === "user" && asBubble.turnId) {
        current = { id: asBubble.turnId, messages: [message] };
        turns.push(current);
      } else if (current) current.messages.push(message);
    }
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      if (!contexts.current.has(turn.id)) {
        const user = bubble(turn.messages[0]);
        contexts.current.set(turn.id, {
          profileId: options.profileId,
          profileName: options.profileName,
          sessionId: options.sessionId ?? undefined,
          skills: [...options.skills],
          template: options.template,
          contextFolder: Boolean(options.contextFolder),
          createdAt: user?.timestamp ?? Date.now(),
        });
      } else {
        const context = contexts.current.get(turn.id)!;
        if (options.sessionId) context.sessionId = options.sessionId;
        if (
          context.profileName === context.profileId &&
          options.profileName !== options.profileId
        ) {
          context.profileName = options.profileName;
        }
      }
      const latestLoading = index === turns.length - 1 && options.isLoading;
      if (latestLoading) enrichmentEligible.current.add(turn.id);
      const nextRevision = (revisions.current.get(turn.id) ?? 0) + 1;
      const snapshot = buildWorkRecordSnapshot(
        turn.id,
        turn.messages,
        contexts.current.get(turn.id)!,
        nextRevision,
        latestLoading,
      );
      if (!snapshot) continue;
      const actionLabels = collectActionLabels(turn.messages);
      const enrichmentKey = JSON.stringify({
        prompt: snapshot.prompt,
        attachments: snapshot.attachments.map((attachment) => attachment.name),
        actions: actionLabels,
        result: snapshot.resultSummary,
      });
      const enrichment = enrichments.current.get(turn.id);
      if (enrichment?.key === enrichmentKey) {
        snapshot.title = enrichment.value.title;
        snapshot.steps = enrichment.value.steps.map((label, position) => ({
          id: `generated-${position}`,
          name: "business-step",
          label,
          status: "completed",
          position,
        }));
      }
      const fingerprint = JSON.stringify({
        status: snapshot.status,
        sessionId: snapshot.sessionId,
        title: snapshot.title,
        attachments: snapshot.attachments,
        steps: snapshot.steps,
        result:
          snapshot.status === "running" ? undefined : snapshot.resultSummary,
      });
      if (fingerprints.current.get(turn.id) !== fingerprint) {
        fingerprints.current.set(turn.id, fingerprint);
        revisions.current.set(turn.id, nextRevision);
        window.hermesAPI.recordWorkRecordSnapshot(snapshot);
      }

      if (
        snapshot.status === "completed" &&
        snapshot.resultSummary &&
        options.enrichWorkRecord &&
        enrichmentEligible.current.has(turn.id) &&
        enrichmentRequests.current.get(turn.id) !== enrichmentKey &&
        enrichment?.key !== enrichmentKey
      ) {
        enrichmentRequests.current.set(turn.id, enrichmentKey);
        const input: WorkRecordEnrichmentInput = {
          prompt: snapshot.prompt,
          attachments: snapshot.attachments.map(
            (attachment) => attachment.name,
          ),
          actions: actionLabels,
          result: snapshot.resultSummary,
        };
        void options
          .enrichWorkRecord(input)
          .then((text) => {
            if (
              !mounted.current ||
              enrichmentRequests.current.get(turn.id) !== enrichmentKey
            )
              return;
            const parsed = parseWorkRecordEnrichment(text);
            if (!parsed) return;
            enrichments.current.set(turn.id, {
              key: enrichmentKey,
              value: parsed,
            });
            refreshEnrichments();
          })
          .catch(() => {
            // The local title and deterministic business steps remain valid.
          });
      }
    }
  }, [
    options.messages,
    options.profileId,
    options.profileName,
    options.sessionId,
    options.skills,
    options.template,
    options.contextFolder,
    options.isLoading,
    options.enrichWorkRecord,
    enrichmentEpoch,
  ]);
}
