# Market Report Evidence Workflow

The report contains chapters because each section answers a different business decision and depends on different evidence. The source map below decides what to retrieve; the model only turns missing evidence categories into concrete search queries.

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
| 0.1     | Historical project asset table                              | A, B, C                                                    |
| 0.2     | Personnel capability and available-capacity table           | D, E                                                       |
| 0.3     | Evidence-backed capability matrix                           | Derived from 0.1 and 0.2                                   |
| 1.1     | Demand-side market map                                      | 0.3, H, sales interviews                                   |
| 1.2     | Named customer priority                                     | 1.1, H, sales and business-owner interviews                |
| 2.1     | Contractible service catalog                                | 0.3, A, C, E                                               |
| 2.2     | Evidence-backed differentiation                             | A, B, G, sales interviews                                  |
| 3       | Existing-customer expansion opportunities                   | A, B, 0.3, customer-contact interviews                     |
| 4.1     | Missed-business gap inventory                               | Sales interviews, tender requirements, 0.2, 0.3            |
| 4.2     | Gap choices across people, tools, process, and channels     | 4.1, D, F, G, business-owner interviews                    |
| 5.1     | Current market trends                                       | H                                                          |
| 5.2     | Implications at the intersection of trends and capabilities | 0.3, 5.1                                                   |
| 6       | Decisions and 90-day actions                                | All supported prior sections and business-owner interviews |

## Retrieval rounds

For a full report, begin with one batched foundation round rather than a separate call for every section:

1. A/B/C queries for project definitions, delivery, quality, and retained assets.
2. D/E queries for personnel project history, roles, schedules, and additional capacity.
3. F/G queries for tools, SOPs, and organization evidence likely to support later sections.
4. Interview-record queries for missed opportunities, customer expansion, constraints, owners, and deadlines when those records exist in the collection.

Generate 0.1 and 0.2 from retrieved evidence, then derive 0.3. Carry 0.3 as structured derived context into sections 1–6. Query RAG again only for a named evidence category that the initial batch did not cover; do not retrieve 0.3 because it was generated in the current task.

## Chapter state management

For a full report, retrieval remains batched but generation is stateful. Use `market_report_workflow` to enforce the order `0.1 → 0.2 → 0.3 → 1.1 → 1.2 → 2.1 → 2.2 → 3 → 4.1 → 4.2 → 5.1 → 5.2 → 6`.

Submit one completed section at a time. After 0.3 is accepted, the tool freezes it and returns the same capability matrix with every later section. A later section may use earlier generated sections as dependency context, but generated content is never converted into a source citation. Finish with `finalize`; if any chapter is missing, finalization must fail.

The state tool rejects chapters above its context budget instead of cutting them mid-text. Produce a more compact structured section and resubmit it. State belongs to the current chat task and is not persisted across Agent restarts.

## Query planning examples

Weak query: `生成第 0 章。`

Strong query group:

- `标注规则文档中各项目的数据模态、任务类型、标签体系、验收标准、工具和导出格式`
- `质检报告和验收记录中各项目的准确率、Kappa、返工率、badcase 和实际达成情况`
- `结项报告和复盘纪要中各项目的交付量、周期、客户行业和沉淀资产`
- `人员排班和项目记录中每人的角色、参与项目、可反推的标注能力和新增人天/月`

When supplementing, name what is absent: `缺少项目 X 的实际准确率与返工率，检索该项目质检报告或验收记录`.

## Composition contract

Each section is composed from four inputs:

1. Task: the business question and audience.
2. Evidence: selected internal chunks, prior structured sections, and explicitly identified public sources.
3. Output goal and structure: the table or decision artifact expected for that section.
4. Evidence constraints: cite sources, attach time and measurement scope to numbers, and mark unsupported items missing.

There is no separate detailed writing-style block. Removing it is reasonable because style prescriptions can over-constrain the model; output structure and evidence constraints preserve consistency without dictating prose.
