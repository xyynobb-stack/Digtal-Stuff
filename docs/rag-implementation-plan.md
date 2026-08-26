# JingYuAI Desktop RAG 简化实施方案

> 状态：历史提案，已被后续 MVP 方案替代，不作为当前实现说明。
>
> 架构：用户本地 Hermes + 远程 RAG 服务 + 远程向量数据库

当前 MVP 由 Agent 调用远程向量化接口和 Milvus 检索，数据入库由外部团队负责，不包含下文的本地目录同步。当前报告编排以 `market-report-rag` Skill、工作流工具及 `lat.md/` 中的相关说明为准；以下保留早期方案供追溯。

## 1. 方案结论

RAG 的主要计算放在远程服务器，用户本地不运行 Embedding、向量相似度计算或精排模型。

用户本地 Hermes 只负责：

- 选择需要同步的工作目录。
- 检测文件新增、修改和删除。
- 通过 API 上传变化的数据。
- 把用户问题和工作区范围发送给远程 RAG 服务。
- 接收最终检索片段，在本地做 token 上限检查后注入 Prompt。

远程服务负责：

- 文档解析和切块。
- 文档及问题的 Embedding。
- 向量相似度检索。
- BM25/关键词检索。
- 多路结果归并和去重。
- 精排。
- 返回片段及文件、页码、行号等引用信息。

团队需要自研的是 RAG API、工作区同步、权限隔离、召回编排和引用展示；Embedding 模型、向量数据库、文档解析器和精排模型使用成熟组件。

## 2. 总体架构

```text
用户电脑
┌─────────────────────────────┐
│ JingYuAI Desktop / Hermes   │
│                             │
│ 1. 扫描工作目录             │
│ 2. 上传变化文件             │
│ 3. 发送检索请求             │
│ 4. 接收片段并注入 Prompt    │
└──────────────┬──────────────┘
               │ HTTPS API
               ▼
远程服务器
┌─────────────────────────────┐
│ RAG API / Orchestrator      │
│                             │
│ 认证、切块、Embedding       │
│ 多路召回、归并、去重、精排  │
└───────┬──────────┬──────────┘
        │          │
        ▼          ▼
  向量数据库    文档/元数据存储
```

本地客户端不能直接连接向量数据库，也不能持有向量数据库密钥。所有访问都通过远程 RAG API 完成。

## 3. 计算资源放在哪里

| 环节 | 运行位置 | 使用资源 |
| --- | --- | --- |
| 工作目录扫描和文件哈希 | 用户本地 | 少量 CPU、磁盘读取 |
| 文档解析和切块 | 远程 RAG Worker | 远程 CPU |
| 文档 Embedding | 远程 Embedding 服务 | 远程 GPU/CPU |
| Query Embedding | 远程 Embedding 服务 | 远程 GPU/CPU |
| 向量相似度计算 | 远程向量数据库 | 远程内存、CPU、向量索引 |
| BM25/关键词检索 | 远程检索服务 | 远程 CPU、内存 |
| 多路归并和去重 | 远程 RAG API | 少量远程 CPU |
| 精排 | 远程 Reranker | 远程 GPU，或第三方 Rerank API |
| 最终 token 截断 | 用户本地 Hermes | 少量 CPU |
| Prompt 注入 | 用户本地 Hermes | 少量 CPU |

向量数据库负责执行近似最近邻搜索，不应把大量向量下载到用户电脑计算余弦相似度。

多路归并由远程 RAG API 完成。建议使用 RRF 合并向量检索和 BM25 结果，因为两种检索的原始分数不能直接相加。

精排只处理归并后的前 10～30 条候选，最终返回 3～6 条，不对全库执行精排。

## 4. 文档同步和建库

### 4.1 首次同步

```text
用户选择工作目录
  → 本地生成 workspace_id
  → 扫描允许的文件
  → 通过 API 上传文件
  → 远程解析和切块
  → 远程生成 Embedding
  → 写入远程向量数据库
  → 返回同步结果
```

远程索引数据至少需要包含：

- `tenant_id`
- `user_id`
- `workspace_id`
- `document_id`
- 文件相对路径
- 文件内容哈希
- chunk 文本
- chunk 向量
- 行号或页码
- 索引版本

### 4.2 增量同步

本地只维护轻量同步清单，不保存完整向量索引：

```text
<HERMES_HOME>/rag/workspaces/<workspace-id>/manifest.json
```

`manifest.json` 记录文件路径、大小、修改时间、内容哈希和远程同步状态。

每次同步时：

- 新文件：上传并新增远程索引。
- 修改文件：上传新版本，远程替换原有 chunks。
- 删除文件：通知远程删除对应 chunks 和向量。
- 未变化文件：跳过。

这样索引可以根据原始数据直接建立，同时避免每次启动重新上传和重新 Embedding。

## 5. 查询流程

用户提问时，本地 Hermes 调用远程检索接口：

```text
用户问题
  → 本地确定 tenant、user、workspace 和 token 预算
  → 调用远程 /retrieve
  → 远程生成 Query Embedding
  → 并行执行向量检索和 BM25
  → RRF 归并、权限过滤、去重
  → 精排候选
  → 返回最终片段和引用
  → 本地检查 token 上限
  → 注入本轮 Prompt
  → 调用当前配置的 LLM
```

推荐请求：

```json
{
  "workspaceId": "workspace_xxx",
  "query": "用户本轮问题",
  "topK": 5,
  "maxContextTokens": 5000
}
```

推荐响应：

```json
{
  "results": [
    {
      "citationId": "src_01",
      "path": "src/main/hermes.ts",
      "startLine": 1176,
      "endLine": 1191,
      "content": "检索到的片段",
      "score": 0.91
    }
  ]
}
```

本地只把最终 3～6 条结果注入 Prompt，不保存远程向量，也不执行第二次精排。

## 6. 远程 RAG 服务

远程服务器至少包含四个逻辑组件：

```text
RAG Gateway
├── Index Worker
├── Embedding Service
├── Vector/Keyword Store
└── Reranker
```

### RAG Gateway

- 用户认证和限流。
- 强制添加 `tenant_id`、`user_id`、`workspace_id` 过滤。
- 编排向量检索、BM25、归并、去重和精排。
- 返回引用信息。

### Index Worker

- 接收上传文件。
- 解析 PDF、Word、Markdown、代码等内容。
- 切块并生成稳定的 `document_id` 和 `chunk_id`。
- 更新或删除远程索引。

### Embedding Service

- 文档和查询必须使用相同的 Embedding 模型版本。
- 模型升级时通过索引版本触发重建。
- 使用批量处理降低建库成本。

### Vector/Keyword Store

- 保存向量、chunk 文本和引用元数据。
- 如果向量数据库不适合保存完整文本，则额外使用对象存储或文档数据库保存 chunk 文本。
- 精排服务必须能根据 `chunk_id` 获取原文。

### Reranker

- 输入用户问题和少量候选片段。
- 输出重新排序后的候选。
- GPU 不可用时允许关闭精排，直接返回融合结果。

## 7. 最小 API

第一版只需要以下接口：

```text
POST   /api/rag/workspaces
POST   /api/rag/workspaces/:id/files
DELETE /api/rag/workspaces/:id/files
GET    /api/rag/workspaces/:id/status
DELETE /api/rag/workspaces/:id
POST   /api/rag/retrieve
```

建议文件上传和索引任务异步执行。上传接口返回 job id，本地通过状态接口或 WebSocket 获取进度。

所有接口必须鉴权，并且服务端根据登录身份确定 `tenant_id` 和 `user_id`，不能直接信任客户端传入的租户字段。

## 8. Desktop 改动

Desktop 只增加必要功能：

1. 添加或删除知识库目录。
2. 显示同步进度、文件数、错误和最后同步时间。
3. 将当前 context folder 映射到对应 `workspace_id`。
4. 文件变化后触发增量同步。
5. 聊天前调用 `/api/rag/retrieve`。
6. 把返回片段注入当前请求。
7. 在回答下方展示来源，支持打开本地文件并定位行号。

RAG API 失败时应直接降级为普通聊天，不阻塞用户请求。

## 9. 安全要求

- 默认不上传 `.env`、私钥、凭据目录和明显 secret 文件。
- 上传前确认文件仍位于用户选择的工作目录中。
- 所有远程查询必须强制执行租户、用户和 workspace 过滤。
- 远程数据库不能只依赖客户端过滤。
- 传输使用 HTTPS，远程数据使用静态加密。
- 检索片段视为不可信数据，不允许其中的文字改变系统指令。
- 删除知识库时同时删除远程文件、chunks、向量和元数据。
- 日志记录文档 id、耗时和错误，不记录完整文档内容。

需要在产品中明确告知用户：启用该方案后，选中的文档内容会上传到远程 RAG 服务用于解析、Embedding、检索和精排。

## 10. 实施步骤

### 第一阶段：远程检索 MVP

- 实现 workspace 和文件同步 API。
- 实现远程解析、切块和 Embedding。
- 接入远程向量数据库。
- 实现向量检索。
- 本地完成同步清单和 Prompt 注入。

### 第二阶段：混合检索

- 增加 BM25/关键词检索。
- 使用 RRF 做多路归并。
- 增加去重和路径过滤。
- 增加远程精排。

### 第三阶段：Desktop 产品化

- 增加知识库管理和同步状态 UI。
- 增加 context folder 自动绑定。
- 增加回答引用和本地文件定位。
- 完善删除、重试、限流和错误降级。

## 11. 验收标准

- 用户本地不安装或运行 Embedding、向量数据库和精排模型。
- 相似度检索、BM25、归并、去重和精排全部在远程完成。
- 本地只上传变化文件，不重复上传未修改内容。
- 删除或修改文件后，远程索引能够正确同步。
- 检索结果不会跨用户或跨 workspace。
- 最终回答能够显示正确的文件、页码或行号来源。
- 远程 RAG 服务不可用时，普通聊天仍然可用。
- 本地聊天 UI 不因索引和检索计算出现明显卡顿。

## 12. 最终建议

采用“本地轻客户端 + 远程完整 RAG 服务”的模式：

- 本地管理工作目录、同步清单、API 调用和 Prompt 注入。
- 远程完成建库、Embedding、相似度检索、多路归并和精排。
- 向量数据库只通过 RAG Gateway 访问。
- 第一版先完成向量检索闭环，再增加 BM25、RRF 和精排。

这种分工能保证不同用户电脑上的性能一致，也方便统一升级模型、扩容 GPU、控制权限和统计服务成本。
