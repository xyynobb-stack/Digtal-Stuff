---
name: hr-analysis-report-rag
description: 使用公司内部知识库生成人力资源分析报告 Word 文档；适用于人员结构、技能矩阵、产能、缺口、培训和组织风险分析。
---

# 人力资源分析报告

本 Skill 在不处理入库的前提下，复用公司 RAG 查询和统一章节工作流，生成可追溯的 Word 人力资源分析报告。

## 约束与流程

- 只查询 `default.my_skill_kb`；以员工编号或岗位维度分析，不输出不必要的个人敏感信息。
- 不把缺失的薪酬、绩效、合同等资料推断为事实；没有证据时明确标为待补充。
- 使用 Execute Code 和 `sys.executable` 运行本 Skill 的 `scripts/rag_client.py`，不得使用 PATH 中的系统 Python。
- 调用 `analysis_report_workflow(report_type="hr")`。先并行生成 0.1 人员结构和 0.2 技能矩阵，再生成 0.3 产能基线；后续章节共享这三节并行生成。
- 每节提示词使用任务、证据、结构、证据约束四块；最多两轮批量补检。
- 完成后按 [Word 报告契约](references/document-contract.md) 生成 `.docx`。

检索实现与市场报告共用同一受控客户端，配置与真实 Schema 见市场报告 Skill 的 `references/configuration.md`。
