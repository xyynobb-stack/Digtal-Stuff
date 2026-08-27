---
name: finance-analysis-report-rag
description: 使用公司内部知识库生成财务与经营分析报告 Word 文档；适用于收入、直接成本、返工成本、单位经济性、风险和行动建议。
---

# 财务与经营分析报告

本 Skill 输出基于内部项目资料的经营估算，不替代正式会计报表、审计或税务结论。

## 约束与流程

- 只查询 `default.my_skill_kb`，合同、报价、验收、结项、工时、质检和返工记录必须区分事实、口径和估算。
- 缺少完整财务报表、薪酬、税务、银行或应收账龄时，在第0章声明边界，不得补造数字。
- 使用 Execute Code 和 `sys.executable` 运行本 Skill 的 `scripts/rag_client.py`，不得使用系统 Python。
- 调用 `analysis_report_workflow(report_type="finance")`：先生成第0章口径边界；收入和 2.1/2.2/2.3 成本章节并行；再并行生成单位经济性、风险和行动。
- 每节提示词使用任务、证据、结构、证据约束四块；最多两轮批量补检。
- 完成后按 [Word 报告契约](references/document-contract.md) 生成 `.docx`。

检索实现与市场报告共用同一受控客户端，配置与真实 Schema 见市场报告 Skill 的 `references/configuration.md`。
