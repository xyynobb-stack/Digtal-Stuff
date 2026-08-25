# Market Report RAG MVP

The Desktop-managed RAG Skill retrieves internal evidence for factual answers and a structured market report while the production RAG service is unfinished.

## Scope

The Agent owns intent judgment, evidence-query planning, evidence selection, and final composition. It does not own document ingestion, chunking, index updates, vector calculation, or Milvus similarity computation.

The temporary MVP has two remote operations: [[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/embedding_client.py#embed_texts|query embedding]] and [[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/rag_client.py#retrieve|Milvus search]]. A future RAG API should replace this direct composition without changing the report workflow.

## Skill deployment

The Skill is a Desktop-owned Hermes runtime overlay so it is discoverable as a bundled Skill and is not gated as a per-chat user custom Skill.

The canonical files live under `resources/hermes-agent-overlays/skills/research/market-report-rag`. Offline runtime preparation and overlay application copy the whole tree into the staged Agent runtime. Bundled skill synchronization then installs or updates it in a profile using the existing manifest rules described by [[chat-commands#Slash command execution#Session Skill activation]].

## Configuration boundary

Endpoint and test-schema defaults are non-secret, while an enabled database credential remains a runtime environment variable.

[[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/rag_client.py#load_milvus_config]] defaults to database `default`, collection `my_skill_kb`, fields `embedding`/`text`/`source`, 1024 dimensions, and inner-product search while keeping every value overridable. `MILVUS_TOKEN` is passed only when configured.

Only `text` and `source` are requested as output fields. The stored 1024-dimensional vector is not returned to the Agent context.

The repository does not store the supplied Milvus credential. The Python runtime needs `pymilvus`, declared by the Skill's `requirements.txt`; Windows release jobs and macOS runtime preparation install it, while a local prebuilt runtime needs administrator setup.

## Runtime flow

One Skill invocation is a stateless online retrieval transaction from planned questions to normalized evidence.

### Embedding request

All planned questions are sent in one JSON request to the remote `bge-m3` endpoint, and response vectors are restored to input order and validated for count, dimension, numeric values, and finiteness.

Only transient transport, 408, 429, and server errors receive bounded retries. Invalid input and malformed responses fail immediately.

### Milvus search

The query-vector batch is passed to one `MilvusClient.search` call, and one result group is returned for every query.

The client is constructed inside the invocation and closed in `finally`. Search candidates retain complete stored entities; the Agent selects whole chunks rather than cutting a chunk mid-text.

## Query and report orchestration

The model rewrites user goals into evidence-oriented questions and generates chapter content; Python performs no LLM rewriting or prose generation, but a process-local state machine validates chapter transitions.

For the full report, the source map in the Skill reference fixes what each section needs. The Agent first retrieves project, quality, closeout, personnel, capacity, tool, SOP, and interview evidence in a small batch. It builds sections 0.1 and 0.2, derives the capability matrix 0.3, and reuses that structured context for later sections.

A supplement retrieval happens only when a required evidence category is missing. It names the missing document, entity, time range, or field and is capped at two rounds. Generated report prose is never treated as retrieved evidence.

[[resources/hermes-agent-overlays/tools/market_report_workflow_state.py#MarketReportWorkflowStore]] enforces one-section-at-a-time generation in the fixed order. Section 0.3 becomes an immutable capability matrix carried into every later section, and finalization fails until all sections are present.

The state tool rejects oversized chapter submissions rather than silently truncating them. The model must produce a more compact structured chapter and resubmit it, preserving whole evidence statements and source references.

The composition prompt contains task, evidence, output goal and structure, and evidence constraints. It intentionally omits a separate detailed writing-style block so format and traceability remain stable without over-constraining prose.

## Concurrency decisions

RAG invocations share no mutable Python state. Chapter orchestration has bounded process-local state isolated by the Hermes task identifier.

There is no module-global Milvus connection, output file, cache, lock, or mutable configuration. Each process reads an immutable environment snapshot, embeds one batch, opens one Milvus client, performs one search, and closes it. A failed search cannot leave a shared connection or partial result file behind.

[[resources/hermes-agent-overlays/tools/market_report_workflow_state.py#MarketReportWorkflowStore]] serializes state transitions with an in-process reentrant lock. It keeps at most 128 task states and never writes a shared state file, so concurrent chats cannot overwrite each other and separate Agent processes cannot race on disk. State intentionally does not survive an Agent restart.

The wider Desktop has existing check-then-copy windows while provisioning custom or bundled Skills. This Skill avoids adding another profile-copy path by using the managed runtime overlay and relies on the existing atomic bundled manifest write. Concurrent first-time profile seeding remains an upstream lifecycle concern, not retrieval state shared by this implementation.

## Failure behavior

Expected failures are machine-readable and must not turn into fabricated internal facts.

Configuration, dependency, embedding, Milvus search, and response-shape failures return a JSON error code and a nonzero exit status. Tokens are never included in success output or error text. `--check-config` validates settings without importing `pymilvus` or contacting either service.

## Tests

The MVP is verified without using live credentials, the embedding endpoint, or the Milvus server.

### Embedding batching and validation

The embedding client sends a batch once, restores indexed response order, and retries only explicitly transient failures.

### Connection configuration fails before network access

An explicitly empty URI, database, or collection stops the workflow before embedding or Milvus client construction.

### One-shot retrieval has no shared client state

Multiple queries use one embedding batch and one Milvus search, the client always closes, normalized evidence is returned, and credentials are absent from output.

### Chapter orchestration preserves dependencies

The workflow rejects out-of-order and duplicate sections, freezes 0.3 for dependent chapters, caps focused supplement retrieval at two rounds, and refuses finalization before all chapters exist.

### Concurrent chapter updates are serialized

Concurrent updates for the same task allow only the valid next transition, while different task identifiers retain independent chapter progress.
