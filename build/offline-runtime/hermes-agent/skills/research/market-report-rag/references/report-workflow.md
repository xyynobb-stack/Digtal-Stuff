# Market Report Evidence Workflow

The report contains chapters because each section answers a different business decision and depends on different evidence. The source map below decides what to retrieve; the model only turns missing evidence categories into concrete search queries.

## Deliverable outline contract

The Word deliverable contains seven user-visible chapters: `第 1 章 能力资产盘点`, `第 2 章 我们可以去找哪些目标客户`, `第 3 章 我们能为这些客户做什么`, `第 4 章 存量客户能不能再深挖`, `第 5 章 没承接的业务还缺什么资源`, `第 6 章 市场趋势`, and `第 7 章 结论与行动`.

The `docx` Skill may format these sections but may not replace them with a generic market-research outline. It must receive all 13 finalized generation units before creating the file.

## Evidence categories

| Code | Internal evidence                                                                |
| ---- | -------------------------------------------------------------------------------- |
| A    | Annotation rules and specifications                                              |
| B    | Quality reports, acceptance records, and bad-case lists                          |
| C    | Project closeout reports and retrospectives                                      |
| D    | Personnel skills confirmed by team leads                                         |
| E    | Work hours, schedules, project assignments, and available capacity               |
| F    | Annotation tools and platforms                                                   |
| G    | Internal SOPs and organization information                                       |
| H    | Current external market evidence; normally use public research, not internal RAG |

Contract amounts, cost and margin, collection ledgers, certificates, and CRM data are out of scope. Mark their report positions `待商务/行政补充`.

## Dependency and retrieval map

| Section | Decision/output goal                                        | Evidence                                                   |
| ------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| 1.1     | Historical project asset table                              | A, B, C                                               |
| 1.2     | Personnel capability and available-capacity table           | D, E                                                  |
| 1.3     | Evidence-backed capability matrix                           | Derived from 1.1 and 1.2                              |
| 2.1     | Demand-side market map                                      | Chapter 1, H, sales interviews                        |
| 2.2     | Named customer priority                                     | Chapter 1, H, sales and business-owner interviews     |
| 3.1     | Contractible service catalog                                | Chapter 1, A, C, E                                    |
| 3.2     | Evidence-backed differentiation                             | Chapter 1, A, B, G, sales interviews                  |
| 4       | Existing-customer expansion opportunities                   | Chapter 1, A, B, customer-contact interviews          |
| 5.1     | Missed-business gap inventory                               | Chapter 1, sales interviews, tender requirements      |
| 5.2     | Gap choices across people, tools, process, and channels     | Chapter 1, D, F, G, business-owner interviews         |
| 6.1     | Current market trends                                       | Chapter 1, H                                          |
| 6.2     | Implications at the intersection of trends and capabilities | Chapter 1, H                                          |
| 7       | Decisions and 90-day actions                                | Chapter 1 and business-owner interviews               |

## Retrieval rounds

For a full report, begin with one batched foundation round rather than a separate call for every section:

1. A/B/C queries for project definitions, delivery, quality, and retained assets.
2. D/E queries for personnel project history, roles, schedules, and additional capacity.
3. F/G queries for tools, SOPs, and organization evidence likely to support later sections.
4. Interview-record queries for missed opportunities, customer expansion, constraints, owners, and deadlines when those records exist in the collection.

Generate 1.1 and 1.2 together from retrieved evidence, then derive 1.3. Carry the complete chapter-1 foundation as structured context into chapters 2–7. Query RAG again only for a named evidence category that the initial batch did not cover; do not retrieve 1.3 because it was generated in the current task.

## Chapter state management

For a full report, retrieval remains batched but generation is stateful. Use `market_report_workflow` to enforce three waves: `(1.1 + 1.2) → 1.3 → (2.1 + 2.2 + 3.1 + 3.2 + 4 + 5.1 + 5.2 + 6.1 + 6.2 + 7)`.

Submit every section in the current wave with one atomic `record_wave` call. Wave 1 produces 1.1 and 1.2 in the same model turn; wave 2 derives and freezes 1.3; wave 3 generates every remaining unit from that foundation in one model turn. Generated content is never converted into a source citation. Finish with `finalize`; if any unit is missing, finalization must fail.

The state tool rejects chapters above its context budget instead of cutting them mid-text. Produce a more compact structured section and resubmit it. State belongs to the current chat task and is not persisted across Agent restarts.

## Query planning examples

Weak query: `生成第 1 章。`

Strong query group:

- `标注规则文档中各项目的数据模态、任务类型、标签体系、验收标准、工具和导出格式`
- `质检报告和验收记录中各项目的准确率、Kappa、返工率、badcase 和实际达成情况`
- `结项报告和复盘纪要中各项目的交付量、周期、客户行业和沉淀资产`
- `人员排班和项目记录中每人的角色、参与项目、可验证的标注能力和新增人天/月`

When supplementing, name what is absent: `缺少项目 X 的实际准确率与返工率，检索该项目质检报告或验收记录`.

## Composition contract

Each section is composed from four inputs:

1. Task: the business question and audience.
2. Evidence: selected internal chunks, prior structured sections, and explicitly identified public sources.
3. Output goal and structure: the table or decision artifact expected for that section.
4. Evidence constraints: cite sources, attach time and measurement scope to numbers, and mark unsupported items missing.

There is no separate detailed writing-style block. Removing it is reasonable because style prescriptions can over-constrain the model; output structure and evidence constraints preserve consistency without dictating prose.

## Collection provenance gate

All internal evidence for this workflow comes only from Milvus collection `my_skill_kb` through the bundled `market-report-rag/scripts/rag_client.py` client.

The Agent must verify `collection: "my_skill_kb"` in every retrieval result and pass it to `market_report_workflow.start`. It may not discover an alternate Milvus Skill, call `MilvusClient` directly, or query `project_embeddings`/`project_repo_chunks` when results are empty. The state machine rejects wrong collection values and explicit wrong-collection claims before report content can be committed.
