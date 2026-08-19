# Session model override

The in-chat (bottom) model picker selects a model for the **current conversation only** — it never rewrites `config.yaml`, so the Settings global default is preserved (#688), and carries the full model identity so cross-provider switches route correctly.

The override is held in renderer state on each `<Chat>` run ([[src/renderer/src/screens/Chat/Chat.tsx]]), persisted by session id, and sent with every message; it is cleared when the conversation is cleared/reset and is absent on a fresh chat, so new conversations start on the global default. This is distinct from the persisted [[model-context]] default that non-chat surfaces read.

## Two-pane picker grouped by display brand

The bottom [[src/renderer/src/screens/Chat/ModelPicker.tsx]] dropdown is a two-pane layout: a left **provider rail** filters a right **flat model list**, with a top search box (leading magnifier icon) narrowing both.

The panel is styled as a floating native surface — translucent glass (`backdrop-filter`) lifted on a soft ambient shadow rather than a hard border, a recessed search field, and a filled-tint selection instead of an outlined row — so it reads as a desktop popover, not a web form. Depth comes from light (elevation, highlight, inset), not strokes; all radii use `var(--radius-*)` so the squared-corners theme toggle is respected.

The rail has an "All models" entry plus one row per brand (logo + model count); each list row shows the model title, a `Provider · model-id` subtitle, and a check on the active model. The currently-selected model is sorted **first** within whatever filter is shown (exact provider+model+baseUrl match, then same provider+model), leaving the rest of the list in its original order.

Models are grouped by **display brand**, not the raw stored provider, so OpenAI-compatible providers persisted as `custom` (Hermes One, Groq, DeepSeek, …) get their own rail entry instead of one generic "OpenAI Compatible / Local" bucket. [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#groupModelsByProvider]] derives each group's key/label from [[src/renderer/src/constants.ts#displayBrandFromConfig]], which reverse-maps a `custom` model's `baseUrl` to a brand id via `OPENAI_COMPATIBLE_BASE_URLS` (same reverse-map the [[provider-setup]] active-model picker uses). A `custom` endpoint not in the map stays under "OpenAI Compatible / Local".

Crucially, each model row keeps its **raw** `provider`/`baseUrl` for selection — only the rail grouping/label is branded — so routing and the active-model check (`currentModel === m.model && currentProvider === m.provider`) are unchanged. The rail brand filter is display-only React state; picking "All models" or a brand never rewrites config. The rail logo is the brand's [[src/renderer/src/components/common/BrandLogo.tsx]] (`matchTheme`), with a generic fallback for unknown brands.

A **Configure** button is pinned at the bottom of the provider rail (below the scrollable brand list), replacing the old free-text model input: it closes the picker and dispatches the `navigation:goto` window event (detail `"providers"`) that [[src/renderer/src/screens/Layout/Layout.tsx]] listens for, taking the user to the Providers screen to manage keys and the model library.

## Employee phone model allowlist

Phone-provisioned local users see only the OpenAI-chat models granted by the latest employee lookup response.

The main process persists the grant through [[src/main/employee-model-access.ts#writeEmployeeModelAccess]] and applies it to `list-models`; unrelated rows remain stored but are not returned. [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#useModelConfig]] also suppresses Ollama Cloud discovery merging while the grant is active, preventing live models from bypassing the allowlist. Remote and SSH catalogs, and local installs without a phone grant, retain their normal behavior.

## Full identity, not just the model name

The override is a `SessionModelOverride` (`{provider, model, baseUrl}`), not a bare model string — because switching across providers must change routing, not only the `model` field.

The picker builds it via [[src/renderer/src/screens/Chat/hooks/useModelConfig.ts#effectiveOverrideBaseUrl]], the same baseUrl rule `selectModel` applies (keep the URL only for `custom`/`ollama-cloud`; clear it for named providers that have a canonical base URL), so the session pick and a persisted save can't drift. It is threaded renderer → preload IPC → main `sendMessage` as `modelOverride`.

## Stable runtime route identity

Dashboard sessions use an opaque backend-issued `route_id` so dynamic providers, newly advertised models, provider aliases, and same-name models on different endpoints require no desktop mapping table.

[[resources/hermes-agent-overlays/tui_gateway/methods_desktop_cold_start.py#_route_identity]] hashes the resolved provider, normalized endpoint, and model into a versioned identity without including credentials. `model.resolve`, `session.create`, `session.model.set`, and `model.identity` all return that identity; `session.model.set` rejects a stale supplied id before mutating the session.

[[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#dashboardRouteMatches]] compares route ids when available. For an older Dashboard, it compares the exact normalized identity returned by `model.resolve`, never inferred `custom` or brand aliases. A successful route is cached for the live session, so ordinary later turns skip model resolution and retain the warm Agent.

Route validation failure is a control-plane error, not evidence that the runtime session is corrupt. The renderer reports it without setting the session-recreation flag; transport and session failures still use the existing recovery path.

## Latest picker identity wins

Every dashboard send resolves its model, provider, and base URL from the latest picker intent, even if React has not committed that selection yet or the composer invokes a send callback captured before the user changed models.

[[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]] keeps that routing identity in a live ref and reads it when creating, switching, and validating the runtime session. This prevents a previous conversation model from being reused by a stale UI callback while the picker already displays the new model.

The picker publishes its full identity synchronously to its own Chat transport before scheduling React state. A pending intent is not overwritten by an unrelated render carrying the previous props; matching props acknowledge it without incrementing the generation twice. Thus immediate Send cannot submit the prewarmed default route and leave the later switch to collide with a running turn.

Model changes run through one serialized renderer queue. Its local generation orders asynchronous work only inside the mounted Chat, while the gateway owns a separate session generation; a remounted renderer therefore cannot look stale to a warm backend. The send path crosses the route barrier again immediately before `prompt.submit`, so a slow prewarm cannot become the final mutation after a newer picker choice.

New dashboard sessions send the full identity to `session.create`, whose desktop gateway wrapper resolves the final named route before deferred Agent construction. Resumed sessions use `session.model.set`, an in-process session RPC that bypasses slash-worker initialization and never writes the profile's global model setting.

The rebuilt Agent system prompt is the sole model-identity instruction. The desktop overlay removes legacy user-role model-switch markers from live history and no longer persists new markers, because a resumed stale marker can contradict the actual route and make a correctly routed model report the previous model name.

### In-flight resolution cannot overwrite a newer pick

An older delayed `model.resolve` result is discarded after the picker generation changes; only the newest route may call `session.model.set`, and `prompt.submit` follows that accepted mutation.

### Picker intent precedes React commit

A model picked immediately before Send becomes the route applied to the new runtime session even when the corresponding React model/provider state has not rendered yet.

### Toolbar context changes cannot overwrite picker intent

Skill, writing-template, and folder changes may rerender Chat or restart opportunistic prewarm, but they cannot replace a synchronously published model-picker intent with older rendered props.

### Resumed route beats the temporary default

A resumed conversation reads its authoritative in-process `model.identity` before the first Send and adopts that route when the user has not made a newer explicit choice, instead of briefly switching to the global default.

### Explicit picker beats asynchronous restoration

An explicit model click wins over both the authoritative resume lookup and the desktop-saved override when either asynchronous restoration completes later.

### Server owns selection generation

The gateway increments `model_selection_generation` after each accepted create or switch and returns it as observation metadata; the renderer never supplies that number, because its mount-local counter has a different lifetime.

## Desktop-only persistence

The selected model/provider is saved in a desktop-owned table keyed by session id, without storing API keys.

[[src/main/session-model-override-store.ts]] holds `desktop_session_model_overrides` with `provider`, `model`, and `base_url` only. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] restores the saved value for a resumed session, applies it to the local picker with `persist:false`, and saves later changes once a gateway session id exists. Deleting a session removes the row through [[src/main/sessions.ts#deleteSessionRows]].

## Text-only legacy fallback routes via CLI

Text-only legacy turns can use the CLI fallback when a session override changes provider or base URL away from `config.yaml`.

The dashboard transport applies the full route through `session.create` or `session.model.set`, then attaches media and submits on that same session. [[src/main/hermes.ts#shouldForceCliForSessionOverride]] keeps the CLI escape hatch only for text-only legacy fallback, where it can pass `-m <model>` and `--provider` without dropping attachments. Same-provider model swaps stay on the gateway/API path, where the new `model` string is sufficient. Remote (SSH) mode has no local CLI transport, so it remains limited to the model string.

## Attachment turns stay on session transport

Attachment turns must not be forced through the CLI override fallback because the CLI path cannot carry multimodal input.

[[src/main/hermes.ts#sendMessageViaCli]] can inline text-file attachments but ignores images, while the gateway/API path preserves image parts and path refs through [[src/main/hermes.ts#buildUserContent]]. When a session override is active and the user sends attachments, [[src/main/hermes.ts#shouldForceCliForSessionOverride]] leaves the turn eligible for the dashboard/gateway or API transport instead of silently dropping media.
