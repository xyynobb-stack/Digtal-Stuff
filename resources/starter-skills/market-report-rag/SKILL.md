---
name: market-report-rag
description: 使用公司内部知识库生成七章市场分析报告 Word 文档；适用于市场调研、能力盘点、客户优先级、服务设计和行动建议。
---

# 市场分析报告

本 Skill 只负责 Agent 侧查询、证据组织、章节编排和 Word 输出。知识入库、切分、建索引与更新由 RAG 服务侧负责。

## 必须遵守

- 内部证据只允许来自 Milvus `default.my_skill_kb`，不得改查其他集合；无命中写“资料缺失/待补充”。
- 检索脚本会调用 `bge-m3` 向量接口，再以 `Float16Vector(1024)`、`COSINE` 查询 `embedding` 字段。
- 使用 Execute Code 与当前 `sys.executable` 运行 `scripts/rag_client.py`，不要调用 PATH 中不确定的 `python`，也不要现场安装依赖。
- 完整报告必须使用 `analysis_report_workflow(report_type="market")`；兼容环境可使用 `market_report_workflow`。
- 最终交付 `.docx`，不能只返回 Markdown 或聊天框摘要。

## 流程

1. 把用户目标改写成 3 至 6 条证据查询，一次批量检索项目规则、交付/验收、人员/产能、质检/返工、客户/合同和趋势资料。
2. 校验返回值中 `collection` 必须为 `my_skill_kb`，将紧凑证据索引传给工作流 `start`。
3. 按工作流返回的波次生成：`1.1+1.2` 并行，`1.3` 基于前两节固化，再让第 2 至 7 章并行生成。
4. 每节提示词只包含四块：任务、内部证据、结构/表头、证据约束。不要增加独立的强写作风格块。
5. 资料不足时最多两轮补检；查询由模型按当前缺口生成，并保持批量调用。
6. `finalize` 完成后，读取 [报告结构与表格契约](references/document-contract.md)，使用 docx 工具生成 Word，保留缺失资料标记和来源清单。

## 运行检索

在 Execute Code 中用 `sys.executable` 调用当前 Skill 的脚本，并解析其 JSON；脚本路径位于当前 Profile 的 `skills/custom/market-report-rag/scripts/rag_client.py`。先用 `--check-config` 自检，再以多个 `--query` 参数批量查询。任何 `DEPENDENCY_ERROR` 都应报告安装包运行时不完整，不能改用系统 Python。

配置项和真实 Schema 见 [检索配置](references/configuration.md)。
