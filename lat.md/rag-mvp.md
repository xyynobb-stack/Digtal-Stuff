# Market Report RAG MVP

The Desktop-managed RAG Skill retrieves internal evidence for factual answers and a structured market report while the production RAG service is unfinished.

## Scope

The Agent owns intent judgment, evidence-query planning, evidence selection, and final composition. It does not own document ingestion, chunking, index updates, vector calculation, or Milvus similarity computation.

The temporary MVP has two remote operations: [[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/embedding_client.py#embed_texts|query embedding]] and [[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/rag_client.py#retrieve|Milvus search]]. A future RAG API should replace this direct composition without changing the report workflow.

## Skill deployment

The Skill is a Desktop-owned Hermes runtime overlay so it is discoverable as a bundled Skill and is not gated as a per-chat user custom Skill.

The canonical files live under `resources/hermes-agent-overlays/skills/research/market-report-rag`. Offline overlay application copies the tree into the staged Agent runtime. Before `npm run dev`, `syncDevMarketReportSkill` refreshes both the installed development Agent and default profile so a stale profile copy cannot shadow the canonical Skill. Ownership follows [[chat-commands#Slash command execution#Session Skill activation]].

## Configuration boundary

Endpoint and test-schema defaults are non-secret, while an enabled database credential remains a runtime environment variable. The Skill's evidence boundary is fixed to `my_skill_kb`.

[[resources/hermes-agent-overlays/skills/research/market-report-rag/scripts/rag_client.py#load_milvus_config]] uses database `default`, fixed collection `my_skill_kb`, fields `embedding`/`text`/`source`, 1024 dimensions, and inner-product search. An alternate `MILVUS_COLLECTION` fails before embedding or network access. `MILVUS_TOKEN` is passed only when configured.

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

The model rewrites user goals into evidence-oriented questions and generates chapter content; Python performs no LLM rewriting or prose generation, but a process-local state machine validates collection provenance and generation waves.

For the full report, the source map in the Skill reference fixes what each section needs. The Agent retrieves project, quality, closeout, personnel, capacity, tool, SOP, and interview evidence in a small batch from `my_skill_kb`. It builds 1.1 and 1.2 together, derives capability matrix 1.3, and reuses the whole chapter-1 foundation for chapters 2–7.

A supplement retrieval happens only when a required evidence category is missing. It names the missing document, entity, time range, or field and is capped at two rounds. Generated report prose is never treated as retrieved evidence.

[[resources/hermes-agent-overlays/tools/market_report_workflow_state.py#MarketReportWorkflowStore]] enforces three atomic generation waves: 1.1+1.2, then 1.3, then all remaining units in chapters 2–7. Section 1.3 becomes immutable, and finalization fails until every unit is present.

The RAG result's collection is required by `start`. The client rejects alternate collection configuration, and the state machine rejects both a wrong collection value and explicit references to known alternate project collections in evidence summaries or chapter content.

The state tool rejects oversized chapter submissions rather than silently truncating them. The model must produce a more compact structured chapter and resubmit it, preserving whole evidence statements and source references.

The composition prompt contains task, evidence, output goal and structure, and evidence constraints. It intentionally omits a separate detailed writing-style block so format and traceability remain stable without over-constraining prose.

## Word report delivery

A full report is delivered as a Word `.docx` file rather than pasted into chat as Markdown.

After the chapter state machine finalizes the ordered report content, the Agent loads the bundled `docx` Skill and creates the document in the turn-scoped output directory described by [[context-folder#Linked working folder#Output destination]]. The chat response contains the resulting file path and a short completion message. Missing DOCX dependencies are reported explicitly and never trigger a silent Markdown fallback.

The Word outline is immutable: seven chapters numbered 1–7, containing all 13 state-machine units. Chapter 1 is the evidence foundation. The DOCX Skill performs formatting only and cannot substitute a generic outline, rename sections, or create the file before workflow finalization succeeds.

## Concurrency decisions

RAG invocations share no mutable Python state. Chapter orchestration has bounded process-local state isolated by the Hermes task identifier.

There is no module-global Milvus connection, output file, cache, lock, or mutable configuration. Each process reads an immutable environment snapshot, embeds one batch, opens one Milvus client, performs one search, and closes it. A failed search cannot leave a shared connection or partial result file behind.

[[resources/hermes-agent-overlays/tools/market_report_workflow_state.py#MarketReportWorkflowStore]] validates a whole wave before mutating state, then serializes its atomic commit with an in-process reentrant lock. It keeps at most 128 task states and never writes a shared state file, so concurrent chats cannot overwrite each other. State intentionally does not survive an Agent restart.

## Final message reconciliation

Live generation and final transcript repair use different content authorities so a lagging database snapshot cannot roll the visible response backward.

While an active turn is running, the streamed Assistant and reasoning text remain authoritative; database polling may still add persisted tool rows, attachments, timestamps, and earlier completed rows, but it cannot replace or truncate the current live text or clear its pending state.

After `chat-done`, the authority reverses. Long bubbles are matched by a normalized prefix to prevent DOM remounts, and the persisted Assistant content replaces a dropped stream tail while preserving the live React identity. User content is excluded because persisted user rows can contain hidden attachment transport wrappers.

`chat-done` can arrive before the final SQLite update becomes visible. The renderer therefore performs a bounded settle poll and finishes only after a terminal Assistant `finish_reason` and its full transcript snapshot remain stable; each intermediate snapshot repairs late reasoning and answer content immediately.

The wider Desktop has existing check-then-copy windows while provisioning custom or bundled Skills. This Skill avoids adding another profile-copy path by using the managed runtime overlay and relies on the existing atomic bundled manifest write. Concurrent first-time profile seeding remains an upstream lifecycle concern, not retrieval state shared by this implementation.

## Failure behavior

Expected failures are machine-readable and must not turn into fabricated internal facts.

Configuration, dependency, embedding, Milvus search, and response-shape failures return a JSON error code and a nonzero exit status. Tokens are never included in success output or error text. `--check-config` validates settings without importing `pymilvus` or contacting either service.

A stalled or otherwise unexecuted tool call is a runtime failure, not an empty retrieval result. The Agent retries it once and then stops for user retry; it cannot advance chapter state, finalize, or create a DOCX. If the chapter workflow tool is absent from a live session, free-form report generation is forbidden and the Agent must be restarted or reconfigured.

## Tests

The MVP is verified without using live credentials, the embedding endpoint, or the Milvus server.

### Embedding batching and validation

The embedding client sends a batch once, restores indexed response order, and retries only explicitly transient failures.

### Connection configuration fails before network access

An explicitly empty URI, database, or collection stops the workflow before embedding or Milvus client construction.

### One-shot retrieval has no shared client state

Multiple queries use one embedding batch and one Milvus search, the client always closes, normalized evidence is returned, and credentials are absent from output.

### Wave orchestration preserves dependencies

The workflow atomically accepts only the complete expected wave, freezes 1.3 for chapters 2–7, caps focused supplement retrieval at two rounds, and refuses finalization before all units exist.

### Concurrent wave updates are serialized

Concurrent wave commits for the same task allow only one valid transition, while different task identifiers retain independent progress.

### Alternate collection configuration fails closed

The retrieval client fails before embedding or Milvus client construction when configuration names any collection other than `my_skill_kb`.

### Report provenance rejects wrong collections

Report state rejects mismatched provenance and explicit alternate-collection claims before committing any generated section.

### Final database content replaces streamed previews

A prefix-matched incomplete Assistant stream bubble keeps its React id but receives the full persisted content; user attachment wrappers remain hidden.

### Live stream remains authoritative while the database lags

During an active turn, a prefix-matched shorter database snapshot cannot replace the longer streamed Assistant text, remove its pending state, or collapse an in-progress reasoning row.

### Completion waits for the persisted terminal transcript

After `chat-done`, the renderer keeps polling through partial snapshots until the final Assistant finish marker and the complete reasoning-and-answer snapshot are stable, with a bounded timeout for legacy runtimes.
