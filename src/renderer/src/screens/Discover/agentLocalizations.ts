import type { RegistryItem } from "../../../../shared/registry";

interface AgentLocalization {
  displayName: string;
  displayDescription: string;
}

/** Chinese presentation copy keyed by the Registry's stable Agent id. */
export const AGENT_ZH_CN: Record<string, AgentLocalization> = {
  "accessibility-auditor": {
    displayName: "无障碍审查员",
    displayDescription:
      "审查界面是否符合 WCAG 无障碍标准，并给出具体修复建议。",
  },
  "api-designer": {
    displayName: "API 设计师",
    displayDescription: "设计简洁、一致且文档完善的 HTTP/RPC API。",
  },
  architect: {
    displayName: "架构师",
    displayDescription: "制定实施方案，分析并权衡架构设计中的取舍。",
  },
  "backend-engineer": {
    displayName: "后端工程师",
    displayDescription: "构建健壮、安全的服务端服务、数据访问与业务逻辑。",
  },
  "code-reviewer": {
    displayName: "代码审查员",
    displayDescription: "审查代码差异中的正确性问题，并提出最小化修改建议。",
  },
  "data-analyst": {
    displayName: "数据分析师",
    displayDescription: "探索数据集，基于证据和图表回答问题。",
  },
  debugger: {
    displayName: "调试专家",
    displayDescription: "定位测试失败或软件缺陷的根因，并提出最小修复方案。",
  },
  "devops-engineer": {
    displayName: "DevOps 工程师",
    displayDescription: "编写 CI/CD 流水线、Dockerfile 和部署配置。",
  },
  "doc-writer": {
    displayName: "文档撰写专家",
    displayDescription: "根据代码和上下文编写、更新清晰的技术文档。",
  },
  "frontend-engineer": {
    displayName: "前端工程师",
    displayDescription: "构建可访问、高性能、易维护的界面和前端功能。",
  },
  "incident-responder": {
    displayName: "故障应急专家",
    displayDescription: "处理生产故障、恢复服务并开展无责复盘。",
  },
  "performance-optimizer": {
    displayName: "性能优化专家",
    displayDescription: "基于测量数据分析、诊断并解决性能瓶颈。",
  },
  "prompt-engineer": {
    displayName: "提示词工程师",
    displayDescription: "设计、测试并优化大模型功能使用的提示词。",
  },
  refactorer: {
    displayName: "重构专家",
    displayDescription: "在不改变行为的前提下改善代码结构和可读性。",
  },
  "security-auditor": {
    displayName: "安全审计员",
    displayDescription: "审查代码修改中的安全漏洞和不安全实现。",
  },
  "sql-expert": {
    displayName: "SQL 专家",
    displayDescription: "根据数据库结构编写、解释并优化 SQL 查询。",
  },
  "test-writer": {
    displayName: "测试工程师",
    displayDescription: "为现有代码编写有针对性的单元测试和集成测试。",
  },
};

export function localizeRegistryAgent(item: RegistryItem): RegistryItem {
  const localization = AGENT_ZH_CN[item.id];
  return {
    ...item,
    ...(localization ?? {}),
    displayAuthor: "旌渝",
  };
}
