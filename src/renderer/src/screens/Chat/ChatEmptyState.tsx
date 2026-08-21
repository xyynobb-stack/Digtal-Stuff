import { memo } from "react";
import {
  Bell,
  ClipboardList,
  FileSearch,
  FileText,
  Search,
  Table2,
} from "lucide-react";
import HermesLogo from "../../components/common/HermesLogo";
import { useI18n } from "../../components/useI18n";

interface Suggestion {
  i18nKey: string;
  text: string;
  Icon: typeof Search;
}

// @lat: [[chat-quick-actions#Chinese workplace quick actions]]
const SUGGESTIONS: Suggestion[] = [
  {
    i18nKey: "chat.suggestionSearch",
    text:
      "（如需使用模板，请在聊天框的'写作模板'中选择）请根据我提供的本周工作材料，帮我整理一份工作周报。\n\n" +
      "要求语言简洁、专业，合并重复内容，突出成果和进展。不要编造材料中没有的信息；信息不足时，请先告诉我还需要补充什么。",
    Icon: FileText,
  },
  {
    i18nKey: "chat.suggestionReminder",
    text:
      "请汇总并分析我上传的多份报表，汇总目标是：【请填写汇总目标】。\n\n" +
      "请统一统计周期、指标名称、单位和数据口径，完成以下内容：\n" +
      "1. 汇总各文件中的关键指标\n" +
      "2. 对比不同报表、部门或时间段的数据\n" +
      "3. 找出明显变化、异常数据和缺失项\n" +
      "4. 总结主要趋势和结论\n" +
      "5. 使用表格输出汇总结果\n\n" +
      "如果不同文件的数据口径不一致，请明确说明，不要直接合并或自行推测。",
    Icon: Table2,
  },
  {
    i18nKey: "chat.suggestionEmail",
    text:
      "请读取我上传的文件，并提取其中的关键信息。\n\n" +
      "重点提取：\n" +
      "1. 文件名称、文档类型和日期\n" +
      "2. 涉及的人员、单位或主体\n" +
      "3. 关键数据、金额、时间和地点\n" +
      "4. 主要内容、结论和重要事项\n" +
      "5. 【需要额外提取的字段】\n\n" +
      "请按文件分别整理，并注明信息所在的页码、章节或表格位置。原文中没有的信息标记为“未找到”，不要自行推测。最后将结果汇总成表格。",
    Icon: FileSearch,
  },
  {
    i18nKey: "chat.suggestionScript",
    text:
      "请围绕【需要调研的主题】，查找并对比【对象A】和【对象B】。\n\n" +
      "对比维度包括：【价格、功能、性能、适用场景等，请按需要修改】。\n\n" +
      "要求：\n" +
      "1. 优先使用官方、权威且较新的资料\n" +
      "2. 使用表格展示各项差异\n" +
      "3. 注明数据对应的时间和来源链接\n" +
      "4. 区分已确认事实、第三方观点和你的分析\n" +
      "5. 资料存在冲突或缺失时明确说明\n" +
      "6. 最后总结各自优缺点、适用场景和选择建议\n\n" +
      "不要编造无法确认的数据。",
    Icon: Search,
  },
  {
    i18nKey: "chat.suggestionSchedule",
    text:
      "请在【提醒日期和时间】提醒我：【提醒事项】。\n\n" +
      "重复规则：【仅提醒一次／每天／每周／每月】\n" +
      "时区：【北京时间或其他时区】\n" +
      "补充说明：【可选】\n\n" +
      "创建提醒前，请先确认提醒内容、首次执行时间和重复规则；如果日期、时间或重复规则不完整，请先向我询问，不要自行假设。",
    Icon: Bell,
  },
  {
    i18nKey: "chat.suggestionAnalyze",
    text:
      "请根据我提供的会议记录、转写文本或会议材料，整理一份正式的会议纪要。\n\n" +
      "请按以下结构输出：\n" +
      "1. 会议主题、时间和参会人员\n" +
      "2. 会议背景与目标\n" +
      "3. 主要讨论内容\n" +
      "4. 已达成的决定和结论\n" +
      "5. 待办事项，包括负责人、截止时间和交付内容\n" +
      "6. 尚未解决的问题和后续安排\n\n" +
      "请合并重复内容，去除口语和无关信息。无法确认的发言人、负责人或时间请标记为“待确认”，不要自行补充。",
    Icon: ClipboardList,
  },
];

interface ChatEmptyStateProps {
  onSelectSuggestion: (text: string) => void;
}

export const ChatEmptyState = memo(function ChatEmptyState({
  onSelectSuggestion,
}: ChatEmptyStateProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <HermesLogo size={80} />
      </div>
      <div className="chat-empty-text">{t("chat.emptyTitle")}</div>
      <div className="chat-empty-hint">{t("chat.emptyHint")}</div>
      <div className="chat-empty-suggestions">
        {SUGGESTIONS.map(({ i18nKey, text, Icon }) => (
          <button
            key={i18nKey}
            className="chat-suggestion"
            onClick={() => onSelectSuggestion(text)}
          >
            <Icon size={16} />
            {t(i18nKey)}
          </button>
        ))}
      </div>
    </div>
  );
});
