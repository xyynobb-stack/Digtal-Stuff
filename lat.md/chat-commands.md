# Slash command execution

Typed slash commands (`/compact`, `/compress`, `/reset`, `/web`, …) are run through the gateway's command pipeline, not submitted to the model as plain prompt text. This is what makes them _do_ something instead of being echoed back as prose.

The desktop talks to the hermes-agent gateway over JSON-RPC. A normal message goes via `prompt.submit`, which the gateway treats as a user turn — so a literal `/compact` reaches the model and comes back as text. Real commands must instead go through `slash.exec` (registry-backed worker) with a `command.dispatch` fallback for commands that resolve to an alias, plugin, skill, or an agent prompt.

**Profile scoping over the unified SSH dashboard.** In SSH mode one machine dashboard serves every profile (see [[main-process#SSH dashboard transport]]), so chat calls must carry the active `profile` or the gateway runs them under its launch profile (`default`) — the agent would then answer as `default` even when a named profile is selected. [[src/main/remote-sessions.ts#RemoteSessionConfig]]`.profile` scopes the `/api/*` HTTP ops, and the `/api/ws` chat client passes `profile` on `session.create`/`session.resume` **and** `prompt.submit`/`prompt.background` ([[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#submitDashboardPromptWithRecovery]]); `session.create` builds the agent and persists against that profile's `HERMES_HOME`/`state.db`, and each turn re-binds it. Omitted/`default` → the launch profile (unchanged for local and per-profile-remote setups).

## Routing pipeline

The pure routing logic lives in [[src/renderer/src/screens/Chat/slashExec.ts#executeSlash]]: try `slash.exec`, accept either rendered output or a structured dispatch result, and on rejection fall back to `command.dispatch`, returning `done`, `send`, or `error`.

The name/argument split is done by [[src/renderer/src/screens/Chat/slashExec.ts#parseSlash]], which matches with the dotAll flag so a command's argument may span multiple lines (e.g. a multi-line `/remember` note) — an empty name is what `executeSlash` rejects as an empty command, so a multi-line body must not collapse the match.

It mirrors hermes-agent's reference client (`web/src/lib/slashExec.ts`) so every front-end implements the same contract. Pending-input commands such as `/learn` can return `{type: "send"}` directly from `slash.exec`; that prompt still passes through the central model-submission path.

## Local vs gateway commands

Every typed slash command is resolved through the merged catalog before execution. Ownership is explicit (`target: "desktop" | "agent" | "model"`); display categories such as `info` do not determine routing.

Desktop-only commands delegate to local renderer handlers, Agent commands use the gateway command pipeline, and model commands build a prompt through the shared model-submission formatter. The legacy transport reports Agent commands as unavailable instead of sending raw `/…` text to the model.

## Commands never queue

Slash commands run on the gateway's **persistent slash-worker subprocess**, concurrent with any in-flight turn — so they respond instantly and must NOT sit in the busy queue behind a running turn (only plain prompts queue).

`handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] dispatches every `/…` input immediately to the central router. Desktop and slash-worker commands can complete concurrently; model commands and Agent `send`/skill directives are formatted once and queued when the main model turn is busy.

Because no global loading state is set, the slash branch shows its own feedback: it inserts an in-place `⏳ Running …` agent bubble, buffers the pipeline output, and replaces that bubble with the result (or `error: …`) when the command resolves — otherwise a slow or unreachable gateway would leave the user staring at nothing. Handled UI actions without output silently remove the pending bubble without leaving conversation artifacts.

## Transport connection lifecycle

Every dashboard turn first connects a JSON-RPC WebSocket to the gateway; that handshake must be time-bounded or a stalled socket wedges the whole transport with no error and no fallback (issue #718).

Local desktop chat has exactly one Dashboard owner: the renderer starts the managed `hermes serve --isolated` backend through [[src/main/dashboard.ts#startDashboard]]. The older main-process `TuiGatewayClient` remains permanently disabled by [[src/main/hermes.ts#shouldUseTuiGatewayClient]], so startup, Gateway launch, profile switches, and API fallback cannot warm a second `hermes dashboard` process on ports 9120-9199. The separate 8642 Gateway remains available for its API Server and automation responsibilities.

Local startup publishes one shared readiness promise with the child process. Concurrent status/start callers await that promise instead of interpreting a live PID as a ready router. Readiness first probes lightweight `/api/health`, then completes one short-lived `/api/ws` upgrade so the embedded chat handler is imported before readiness is published. The renderer subsequently owns the retained conversation socket.

[[src/renderer/src/screens/Chat/dashboardGatewayClient.ts#DashboardGatewayClient#connect]] resolves on `open`, rejects on `error` or an early `close`, **and** rejects on a connect-timeout (default 10s). A WebSocket stuck in `CONNECTING` — TCP accepted but the upgrade never completing, e.g. when a busy renderer starves the handshake — fires none of those events on its own, so without the timer the connect promise never settles. When it never settles, `ensureClient` in [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] never resolves, its cached `connectingRef` promise poisons every later send, `setIsLoading(false)` never runs, and the user sees a permanent loading spinner. The timeout makes the promise reject so auto mode falls back to the legacy HTTP transport (and explicit-dashboard mode surfaces a real error) instead of hanging. Per-request calls are separately bounded by their own 30s timeout.

### Runtime session rebinding

An unexpected WebSocket close invalidates the renderer's ephemeral runtime session binding while retaining the durable stored session id, so the next connection must resume or recreate before issuing any session-scoped RPC.

The gateway may reclaim a WebSocket-orphaned runtime after its grace period while the conversation remains persisted. [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] therefore clears runtime-scoped route, readiness, and CWD caches both on the owning socket's `close` callback and on a matching `session.reclaimed` event. A later prewarm or send enters the existing `session.resume`/`session.create` path instead of submitting with a stale id; reclaim broadcasts for other tabs are ignored.

## Layered desktop readiness

Desktop readiness separates the minimum chat path from unrelated services, so the first user turn does not become an implicit backend-startup probe.

Layer 1 is HTTP process/router liveness. The main process starts local Dashboard pre-warming immediately after the versioned Runtime promise reaches `runtime.ready`, independently of whether Chat has mounted. After `/api/health` succeeds, managed startup performs a real `/api/ws` upgrade; only that success publishes `dashboard.ready`.

Layer 2 is conversational readiness. While the user reads the composer, the local renderer opens its retained WebSocket, creates or resumes the runtime session, and applies the selected `{provider, model, base_url}` identity. A concurrent first send shares both connection and session-creation promises, so pre-warming cannot create a duplicate session.

The packaged desktop server skips both the full messaging `hermes_cli.gateway` warm-up and eager all-plugin discovery before binding because loopback desktop chat uses the embedded TUI gateway and needs no public-dashboard auth provider. Agent/tool/plugin paths retain idempotent on-demand discovery; non-Desktop dashboards preserve eager discovery for their fail-closed authentication gate. Slash workers, MCP integrations, provider refresh, and other nonessential facilities remain lazy or background work.

Timing records distinguish `dashboard.http_ready`, `dashboard.chat_ready`, `dashboard.session_prewarm_started`, and `dashboard.session_ready`; session timing begins only after the shared Dashboard connection succeeds, so transient renderer configuration hydration cannot emit duplicate attempts. Failures are diagnostic only, and the normal send path remains the authoritative retry and user-facing error path.

The gateway publishes authoritative `session.readiness.changed` events and a resumable `session.readiness` RPC for each session/model generation. Diagnostic `desktop.timing` events never drive UX state. Background preparation stays unobtrusive and appears near the composer only after 1.2 seconds; opening a new conversation no longer flashes a global startup banner. If a user sends before readiness, the same compact card changes to a blocking wait state and its elapsed counter starts at that `chat.send`, not at application or Agent startup. Ready auto-dismisses, while failures remain visible with their detail.

### Session-scoped monotonic snapshots

Readiness snapshots are ordered only inside one live Dashboard session, preventing delayed RPC replies or notifications from reopening a preparation card after the Agent is ready.

For the same `session_id`, server generation is the primary order, `updated_at_ms` orders snapshots within a generation when both sides provide it, and a terminal `ready`/`failed` phase cannot regress to `creating_session` or `building_agent`. A different session starts a fresh ordering domain, so runtime recovery may legitimately return to generation one. Missing timestamps or session ids remain compatible with older Dashboards instead of being coerced into artificial zero-valued ordering.

A non-empty main-turn model/reasoning delta or successful completion is direct proof that the current Agent exists. The renderer latches that session/generation as ready, clears the preparation timer, and rejects a later same-generation building snapshot. Runtime replacement clears the old cursor while preserving a user turn's blocking-wait start time.

## Cold-session model selection

A new dashboard chat must build its first live Agent with the model selected in the composer, even when Python and Skill discovery are still cold on a newly installed computer.

[[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#ensureDashboardRuntimeSession]] sends `{model, provider, base_url}` to `session.create` as one routing identity. The desktop gateway resolves a generic `custom` billing class to its named local provider before the deferred Agent build and returns both the requested and effective provider in `info`; the first turn cannot start on the profile default and race a later correction.

Existing or resumed sessions switch through the lightweight `session.model.set` RPC. It calls the gateway's in-process session switch directly and, when resume pre-warming has started, queues the route for application immediately before the first model call. Ordinary model selection never invokes `slash.exec`, so it cannot start the slash-worker/CLI/MCP stack; `slash.exec` remains reserved for commands the user types. The message path also never calls `model.options`, so provider discovery, pricing, metadata, or an unavailable network cannot delay the first turn.

[[resources/hermes-agent-overlays/tui_gateway/methods_desktop_cold_start.py#model_options]] makes `model.options` stale-while-revalidate: the first call returns an in-memory/config snapshot immediately, and one background refresh populates the process cache plus the Agent's normal provider/model disk caches. Provider APIs remain authoritative, so newly advertised model IDs arrive through refresh without a desktop release; absent optional metadata can be enriched later without blocking chat.

The desktop also hardens direct `/model` execution. [[src/main/hermes-agent-compat.ts#patchDashboardSlashModelSyncSource]] patches the installed gateway before a local dashboard starts, accepts both LF and Windows CRLF sources, waits for a deferred live Agent, and only then mirrors the slash-worker switch. `scripts/prepare-offline-runtime.mjs` applies that patch and registers the desktop-owned cold-start RPC overlay while staging fresh offline packages, preventing either behavior from depending on the Agent checkout installed on the packaging machine.

## Dashboard up ⇒ /api/ws only (never /v1 fallback)

When a dashboard is available, chat goes through `/api/ws` **only** — never the `/v1` fallback, which 405s over the dashboard tunnel.

This matches the reference `apps/desktop`, which has no `/v1` chat path at all (its `use-prompt-actions.ts` submits via `requestGateway('prompt.submit', …)` with a busy-retry). The fork's main-process `/v1` path (`sendMessageViaApi`/`sendMessageViaRuns`) exists solely for genuine gateway-only remotes; falling to it while a dashboard is up POSTs `/v1` to the dashboard tunnel — which has no `/v1` → **405**.

So `ensureClient` distinguishes two failures: a **genuinely absent** dashboard (`startDashboard` → `running:false`) latches the negative flag and (auto mode) drops to legacy gateway `/v1`; a **transient** WS drop while the dashboard is up (a "socket hang up" from a tunnel blip) instead **retries the connect** (up to 3×, re-running `startDashboard` each time to re-establish the SSH tunnel). If it still can't connect, it throws a `dashboardWasReachable`-tagged error so `sendMessage` **fails the turn for the user to retry** rather than 405-ing on `/v1`.

## Completion text reconciliation

On `message.complete` the desktop treats the persisted `final_response` as canonical for ordinary replies, while tool-using turns may reconcile it with pre-tool streamed text that the final omits (#746).

[[src/renderer/src/screens/Chat/dashboardEventAdapter.ts#completeAssistantWithFinalText]] replaces an ordinary turn's assistant preview with the canonical final text. This cleans reasoning accidentally mislabeled upstream as `message.delta`; `reasoning.delta` remains a separate Thought row. When the turn contains a tool call/result, the helper instead uses [[src/renderer/src/screens/Chat/dashboardEventAdapter.ts#mergeStreamedWithFinal]] to preserve a real pre-tool explanation omitted from the final. On remote/SSH, deltas are not rendered, so the final is always used verbatim.

### Legacy attachment reconciliation

A legacy attachment turn keeps one user bubble and places subsequent reasoning after it, even though the optimistic renderer row and persisted gateway row encode the attachment differently.

[[src/renderer/src/screens/Chat/sessionHistory.ts#reconcileStreamedWithDb]] matches the app-owned path-ref attachment against the persisted `[Attached file: …]` transport marker while comparing the clean user text. It retains the richer optimistic attachment chip, consumes the duplicate database user row, and preserves the canonical ordering of the following Thought and assistant rows. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] also shows a dismissible diagnostic notice whenever the legacy transport is actually invoked; the notice does not change when fallback is selected.

## Streaming source-of-truth ref

`handleGatewayEvent` in [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] applies stream events against a synchronous `messagesRef`, not React state, because state lags a render behind and each successive delta must build on the previous one.

The handler reads the ref, applies a delta, writes the ref back, then calls `setMessages`. An effect mirrors `messages` back into `messagesRef`, and its guard is a correctness invariant. Every `setMessages` in the hook stores the exact same array in the ref, so when React commits the hook's own push, `messages === messagesRef.current` and the effect must skip: re-adopting that snapshot let a second `message.delta` land on a pre-delta array and silently drop a chunk (#757). The effect therefore syncs only when the identity differs (`messages !== messagesRef.current`), which happens only when Chat state changes underneath the hook — a new user turn, `handleClear` emptying the list, or a clarify card resolving in place. A length comparison is wrong here: it misses the shrink and the same-length replacement.

## Reasoning & tool activity rows

Streamed reasoning and tool calls are folded into compact, collapsible transcript rows rather than stacked bubbles, so a turn with heavy thinking or many tool calls stays scannable.

[[src/renderer/src/screens/Chat/HistoryRow.tsx#ReasoningRow]] renders the `Thought` / `Thinking…` row and [[src/renderer/src/screens/Chat/HistoryRow.tsx#ToolActivityGroup]] folds a contiguous run of tool calls/results into one row titled by [[src/renderer/src/screens/Chat/HistoryRow.tsx#toolActivityGroupTitle]]. Each row is collapsed by default and borderless (Codex-style): dim at rest, it brightens and reveals an expand chevron beside the title on hover/focus, and clicking toggles the body open. While the turn is still streaming the leading icon is a thinking-orbs [[loading-indicators|OrbLoader]] (`solving` for reasoning, `working` for tools); once finished it shows the brain/tool glyph.

### Reasoning reconciliation

The live reasoning stream is best-effort — dropped delta chunks leave the streamed row garbled — while state.db holds the canonical text. The DB refresh must collapse the two, or the user sees both stacked in one Thought block.

The observed symptom: a Thought block showing "moon-k3 … ous" (lossy live preview) above "moonshotai/kimi-k3 … nous" (canonical DB row) for the same thought.

Because the garbled text can't match the DB row's text-based reconciliation key, [[src/renderer/src/screens/Chat/sessionHistory.ts#reconcileStreamedWithDb]] ends with [[src/renderer/src/screens/Chat/sessionHistory.ts#dropLossyStreamedReasoning]]: a streamed reasoning row is dropped when [[src/renderer/src/screens/Chat/lossyText.ts#isLossyChunkCopy]] recognises it as a chunk-dropped copy of a DB reasoning row (`db-r-…`) in the **same turn**. A dropped-chunks preview is by construction a concatenation of contiguous runs of the canonical text; the matcher's run (≥3 chars) and length/coverage (≥12 chars, ≥30%) guards separate "same thought, chunks missing" from a genuinely distinct short segment whose characters merely embed as scattered fragments.

#### Lossy live preview collapses into the DB row

A streamed reasoning row recognised as a chunk-dropped copy of the same turn's DB reasoning row disappears from the merge; only the canonical DB text renders. A short thought whose characters embed only as scattered fragments is kept.

#### Distinct live segments survive

A second live reasoning segment that is not a lossy duplicate of any DB row in the turn (multi-segment thinking around tool calls) is kept alongside the reconciled first segment.

#### Turn-scoped matching

The chunk-copy check never crosses turns: a live preview in turn 2 is kept even when its text would match turn 1's canonical reasoning, so repeated questions can't cross-cancel live rows.

## Bubble hover timestamp

Each user/assistant bubble reveals a relative "time ago" label on row hover, so the transcript stays uncluttered at rest but is still scrutable when a user wants to know _when_ something was said.

The canonical time comes from state.db: [[src/renderer/src/screens/Chat/sessionHistory.ts#dbItemsToChatMessages]] copies each row's `timestamp` onto the `ChatBubbleMessage`, and [[src/renderer/src/screens/Chat/sessionHistory.ts#reconcileAfterDbRefresh|the end-of-stream reconcile]] adopts it onto the matching streamed bubble (via `mergeDbMetadataIntoStreamed`) so a live turn picks up its real time after refresh without remounting. state.db stores times in **seconds**, so `toEpochMs` in MessageRow scales any sub-`1e12` value up to milliseconds before use (otherwise it renders as ~Jan 1970). [[src/renderer/src/screens/Chat/MessageRow.tsx#formatBubbleTime]] builds the label with date-fns `formatDistanceToNowStrict` (e.g. "5 minutes ago", "just now" under 10s), with `formatBubbleTimeAbsolute` supplying the exact date/time as the `<time>` element's `title`/`dateTime`. The `.chat-message:hover .chat-bubble-time` CSS fades it in below the bubble, anchored to `.chat-message` because `.chat-bubble`'s own `overflow` would clip it.

## Renderer-native commands

A few non-local commands have dedicated desktop handling and must NOT be diverted to the gateway slash pipeline, or they'd lose their behaviour.

The approval responses `/approve` and `/deny` (the `RENDERER_NATIVE_SLASH` set) are excluded from the pipeline and sent as prompt-level input, matching their dedicated button handlers — `slash.exec` rejects pending-input commands anyway.

## Session Skill activation

Bundled/system Skills are available in every conversation by default, while locally imported Skills require per-chat activation even when an older import preserved a product-looking category.

The Desktop/TUI gateway must therefore keep the `skills` toolset when it converts platform defaults into an explicit toolset list. `patchDesktopSkillToolsetSource` in `scripts/apply-offline-runtime-overlays.mjs` enforces this for packaged runtimes, and `ensureDevAgentSkillToolset` in `scripts/prepare-dev-agent.mjs` applies the same rule before `npm run dev`; otherwise `skill_view` and the system Skill index disappear together and the model may incorrectly scan files as a fallback. Offline packaging also rejects a staged gateway that lacks either implicit `skills` selection marker, preventing a stale unpatched runtime from entering an installer.

Discover broadcasts a refresh after an add, so its list and the Capabilities Skills page show the same installed set.

[[src/renderer/src/screens/Chat/SessionSkillPicker.tsx#SessionSkillPicker]] lets the user enable imported custom Skills for one chat. The selection remains until deselected. [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] sends an envelope on each ordinary turn; an empty selection means no custom Skills are enabled. The packaged runtime binds it to the active task, filters only custom entries from `skills_list`, and rejects `skill_view` only for unselected custom Skills. Bundled/system Skills bypass this allowlist and remain available. The allowlist is cleared after the turn and never changes the installed library; slash commands are unchanged.

The picker intentionally lists only custom/employee-added Skills, not bundled Skills copied into the profile. [[src/main/skills.ts#importLocalSkill]] always installs uploads below `skills/custom`. Once the bundled Skill inventory exists, [[src/main/skills.ts#ensureLegacyUserSkillMarkers]] marks a profile-local legacy entry as user-owned when there is no matching category/name, before the Gateway builds its first Skill snapshot. The complete library remains visible in Discover and Skills management.

[[src/main/hermes.ts#buildGatewayEnv]] enables desktop custom-Skill gating for the Gateway. In that mode [[build/offline-runtime/hermes-agent/agent/prompt_builder.py#build_skills_system_prompt]] omits custom entries from the global Agent skill index but retains bundled/system entries. The runtime Skill tools use the same `custom` category boundary, plus the legacy import marker, so system Skills remain callable while unselected user imports are blocked. The picker shows an enabled label and clear-all action so persisted selections are visible and reversible.

The selection envelope is private transport control data, never user-visible transcript content. [[src/renderer/src/screens/Chat/sessionSkillEnvelope.ts#buildSessionSkillEnvelope]] builds it for Hermes, while [[src/renderer/src/screens/Chat/sessionSkillEnvelope.ts#unwrapSessionSkillEnvelope]] recovers the employee's exact text when older database rows are hydrated. This also lets [[src/renderer/src/screens/Chat/sessionHistory.ts#reconcileStreamedWithDb]] match the optimistic user bubble to the canonical database row, preventing a second wrapped bubble from appearing after refresh.

The packaged Agent uses its existing `persist_user_message` override when it detects this envelope: the full message remains available to the current model turn for allowlist enforcement, but only the clean suffix is written to state.db. `scripts/prepare-offline-runtime.mjs` reapplies that small runtime overlay whenever the offline Agent is staged, so rebuilding cannot silently lose the behavior.

Packaged startup treats `run_agent.py`, `tools/skills_tool.py`, and `agent/prompt_builder.py` as managed desktop overlays. It refreshes them from the package on every launch, so an existing per-user runtime cannot retain the older all-Skills allowlist policy merely because its build marker already matches.

## Side questions (`/btw`)

`/btw` (with aliases `/bg` and `/background`) is a side question that runs on a **concurrent background agent**, so it must never block or queue behind the main turn — that is the point of "ask without affecting context".

It maps to the gateway's `prompt.background` RPC, which spawns a separate agent and reports back later via a `background.complete` event (a normal `prompt.submit` mid-turn is rejected with "session busy"). [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#parseBackgroundCommand|parseBackgroundCommand]] detects these commands; `handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] fires them immediately — bypassing the busy queue — via the shared background flow (also used by the 💭 quick-ask button). The transport's `runBackground` ([[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]]) calls the RPC, and its gateway-event handler renders the `background.complete` answer as a standalone `[bg …]` message. The legacy (non-dashboard) transport has no background RPC and falls back to the blocking quick-ask.

## Central command router

The central slash command architecture in [[src/renderer/src/screens/Chat/slash/handleSlashCommand.ts#handleSlashCommand]] classifies every slash command into a discriminated union (`target: "desktop" | "agent" | "model"`). Unrecognized commands return an error instead of reaching the model as prose.

The router's attachment guard rejects a command run with staged attachments unless it declares `supportsAttachments`, but `target: "desktop"` commands are exempt — they are local UI actions / info displays that never consume attachments (the files stay in the composer for the next message), matching the pre-router behavior where local commands ran unconditionally. Only `agent`/`model` commands, which route content upstream, are gated.

The command palette and executor share a catalog built by [[src/renderer/src/screens/Chat/slash/commandCatalog.ts#createSlashCatalog]]. Hermes Agent metadata comes from `commands.catalog`; Desktop commands are merged after collision validation, and upstream names/aliases are normalized from `/name` to the router's canonical `name`.

[[src/renderer/src/screens/Chat/slash/commandCatalog.ts#reconcileSlashCatalog]] merges the backend catalog with the in-repo desktop commands into a conflict-free catalog before it reaches `createSlashCatalog`. Desktop commands are authored in-repo and win deterministically; the backend catalog is untrusted runtime data, so a collision there must never crash the app. Any backend command whose name equals a desktop command **name or alias** is dropped (missing the alias check let a backend `/commands` command squat `help`'s `commands` alias and crash startup — #813), and a `canon` alias that targets a desktop command becomes an agent-visible alias entry instead.

[[src/renderer/src/screens/Chat/slash/commandCatalog.ts#agentCommandsFromCatalog]] reconciles the gateway's two-part catalog — the flat `pairs` command list and the `canon` alias map — into a self-consistent shape first. Because `createSlashCatalog` deliberately throws on a name registered twice (to catch genuine desktop-authoring conflicts), the reconciler drops any `canon` alias whose name is already a first-class `pairs` command: the backend can legitimately expose the same name as both (e.g. `/compact` is a standalone TUI command _and_ an alias of `/compress`), and without this guard the merge would throw and crash the app on agent connect.

### Desktop commands

Desktop commands in [[src/renderer/src/screens/Chat/slash/desktopCommands.ts#DESKTOP_SLASH_COMMANDS]] handle local Electron/renderer UI operations such as opening settings, triggering the active chat's model picker, and switching navigation views without sending prompts.

The employee build does not register `/office` or `/gateway` navigation commands because those management panes are intentionally absent from the visible shell. This matches [[sidebar-navigation#Employee-facing navigation]] and prevents hidden views from being reached through command autocomplete.

Pure UI desktop actions are flagged `uiAction: true` (settings, model picker, navigation, `/new`, `/clear`, `/fast`). [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] reads that flag to suppress the echoed `/command` user bubble for them — their effect is the UI change itself, so a bubble would be a dangling artifact. Output-producing desktop commands (`/help`, `/memory`, `/usage`, …) are not flagged and still echo, so their output reads as a reply.

`/settings <section>` forwards the section name through `openSettings` to [[src/renderer/src/screens/Layout/Layout.tsx]], which opens the global settings modal on the matching nav item (see [[sidebar-navigation#Settings modal]]). [[src/renderer/src/components/settings/SettingsModal.tsx#resolveSection]] maps the argument to a nav id (`appearance`, `privacy`, `connection`, …, plus the legacy alias `hermesagent` → About); an unknown or omitted name lands on the first item.

Asynchronous Agent commands render a temporary slash-loader bubble without transcript actions such as Copy; the bubble is replaced by the command output or error when execution finishes.

### Agent commands

Agent commands forward upstream via [[src/renderer/src/screens/Chat/slash/executeAgentCommand.ts#executeAgentCommand]] using gateway JSON-RPC.

### Model commands

Model commands and Agent `send`/skill directives pass through [[src/renderer/src/screens/Chat/slash/prepareModelSubmission.ts#prepareModelSubmission]] before entering the standard chat transport. This is the only slash route allowed to submit model content.

### Command icons

Visual presentation in the autocomplete popup is handled by [[src/renderer/src/screens/Chat/slash/SlashCommandIcon.tsx#SlashCommandIcon]], mapping command names to Lucide icons with fallback defaults and a custom SVG registry. Every slash command including desktop settings and navigation shortcuts is assigned an icon.

Custom icons render via `dangerouslySetInnerHTML`, so string SVGs passed to [[src/renderer/src/screens/Chat/slash/SlashCommandIcon.tsx#registerCustomSlashSvg]] are stripped of `<script>`/`<foreignObject>`, inline `on*` handlers, and `javascript:` URIs before storage — a defensive guard (real icons never need them), not a full sanitizer. Only register trusted markup; route remote/plugin-sourced SVG through a proper sanitizer first.

Typing `/` opens a centered command palette in [[src/renderer/src/screens/Chat/ChatInput.tsx#ChatInput]] while the composer retains keyboard focus. Results filter by name or description, stay grouped by category, and support arrows, Enter or Tab, and Escape.

Escape is captured at the document level while the palette is open, so it closes even if focus has moved from the composer into a command row. Dismissal preserves the slash draft and returns focus to the composer.

The palette pre-normalizes searchable command metadata and virtualizes its grouped rows through [[src/renderer/src/screens/Chat/slash/virtualSlashCommands.ts#createSlashCommandVirtualLayout]]. Only visible rows plus a small overscan are mounted, while keyboard selection uses calculated offsets.
