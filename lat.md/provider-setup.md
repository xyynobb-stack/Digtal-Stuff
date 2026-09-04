# Provider setup

The first-run screen where the user picks an AI provider and enters credentials before the app is usable. Rendered by [[src/renderer/src/screens/Setup/Setup.tsx]], it writes the chosen provider/base-URL via `setModelConfig` and any key via `setEnv`.

## Employee phone provisioning

The setup and Providers screens provision an isolated employee Profile by phone, import supported Chat Completions and Responses models, and activate Kimi-2.6 when available without exposing administrator or employee credentials to the renderer.

员工查询使用 `http://36.212.61.62:18600/api/admin/users/lookup-by-phone`，自动配置将模型地址写为 `http://36.212.61.62:18600/v1`。公司接口备用模型策略同步识别该主机与端口。既有 Profile 不在升级时自动重写，需要重新自动配置才能更新其持久化模型地址；飞书 OAuth 与软件更新服务器不受此次迁移影响。

The employee-facing Providers screen is intentionally limited to the phone input, automatic provisioning action, error feedback, and a deduplicated list of configured employees. Each successful record shows the phone, API `real_name`, resolved-or-pending position, and supported conversational model names. Account login, active-model management, provider keys, credential pools, OAuth, auxiliary tasks, and registry controls are not rendered there.

`user_id`, not phone or display name, is the stable employee identity. [[src/main/employee-workspace.ts#employeeProfileIdForUserId]] derives a CLI-safe Profile id and reuses `employee-binding.json` on later lookups; `real_name` becomes display metadata while the stable id and directory stay unchanged. The renderer stores non-secret display metadata locally, migrates legacy `username` metadata only as a display fallback, and keeps former phone-only entries visible with a reconfiguration prompt.

Each successful lookup writes `employee-model-access.json` inside the employee Profile with the returned chat-model ids and company endpoint. [[src/main/employee-model-access.ts#filterModelsForEmployeeAccess]] filters renderer-facing local model reads for the active Profile without deleting the shared underlying model library.

### Identity SOUL and future role binding

Employee identity is committed locally while job behavior remains data-driven and fail-closed when the personnel API has not supplied a position.

[[src/main/employee-workspace.ts#mergeEmployeeSoul]] owns one marked block inside the Profile's `SOUL.md`, preserving global rules and manual content outside that block. The block identifies the employee workspace, forbids impersonation and unsupported real-world authority, and explicitly forbids guessing a missing job from name, department, history, or task content.

[[src/main/employee-workspace.ts#resolveEmployeeRole]] resolves behavior from `position`, with `job_title`, `jobTitle`, and `role` retained only as compatibility aliases. `department` and `department_name` are display metadata and never select a role. A missing position yields `awaiting_position`; an unknown value yields `unmapped`; only a catalog match yields `configured` and mandatory Skills. The catalog maps `研发` to `research-development` and retains `项目经理` to `project-manager`. [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] loads mandatory Skills before enabling Send, merges them with optional session Skills, and prevents the picker from removing them.

The maintained `project-manager` role Skill distills field practice into a reusable operating profile: daily prioritization, project intake and delegation, milestone and quality checks, early risk signals, written change control, cross-team ownership, upward reporting, customer communication, incident recovery, and retrospective closure. Personal biographical details are not promoted into role behavior.

[[src/main/installer.ts#installBundledProfileContent]] refreshes maintained Skills inside the target Profile before role validation. Packaged builds use the offline preset, while development builds use `resources/starter-skills`; this also repairs Profiles left behind by an earlier failed configuration.

### Transaction and race boundary

设置页按 Layout 当前 Profile 显式读取员工绑定和模型授权列表，不再把 localStorage 中最后一次配置历史当作当前身份。切换 Profile 会重建页面并使旧读取及飞书轮询失效；无绑定、加载中与读取错误分别呈现。飞书授权始终携带卡片所属 Profile。绑定格式损坏在专用详情接口中报错，不伪装成未配置；既有聊天读取接口保持原有兼容行为。

Employee provisioning publishes one ready binding only after profile files and the profile-specific gateway are healthy, so Chat cannot observe a half-configured identity.

[[src/main/ipc/register.ts#registerIpcHandlers]] merges duplicate phone requests, serializes work for the same `user_id`, writes credentials and configuration only to the resolved Profile, installs managed content, writes SOUL, restarts or starts that Profile's gateway, and waits for health before [[src/main/employee-workspace.ts#commitEmployeeProvision]] atomically publishes `employee-binding.json`. A pending binding is not readable by Chat.

After a successful provision, [[src/renderer/src/screens/Providers/Providers.tsx#Providers]] passes the authoritative result to the desktop shell instead of reloading the page; first-run Setup carries the same result into the initial Layout mount. The shell switches the selected Profile and visible scratch chat together, injects the returned mandatory Skills immediately, and remounts a re-homed chat at the new Profile boundary so optional session Skills from the former Profile cannot leak across. Relaunch still restores mandatory Skills from the committed binding.

Before mutation, the main process snapshots the Profile-owned environment, model configuration, SOUL, model grant, display metadata, and ready binding. Failure restores that snapshot, keeps the former ready binding authoritative, and writes a secret-free failed marker so an interrupted new Profile can be retried. Different-employee requests may finish independently, but only the latest initiated request may switch the active Profile; an older slow response cannot overwrite the user's newer selection.

### Legacy default continuity

The first employee Profile may claim the pre-employee `default` workspace once, preserving the current user's local history without weakening isolation for later employees.

The claim is serialized across employees and persisted as pending before data publication. [[src/main/employee-workspace.ts#prepareLegacyEmployeeMigration]] uses SQLite online backup for `state.db`, verifies integrity plus session/message counts, copies session artifacts, and merges missing writing templates while leaving the source intact. It refuses to replace a nonempty target; a pending retry accepts a nonempty target only when its session ids and message count prove that the legacy DB was already published. Provisioning pauses when a chat is running, suspends main-process DB opens, blocks Dashboard reconnects, and waits for both source and target Dashboards and gateways to release SQLite before publication. Previously running local services are restored, and the Profile activates only after the migrated target gateway passes health checks.

“我的记录” remains in its Electron-wide WAL database. After the target is healthy, [[src/main/work-records.ts#WorkRecordStore#reassignProfile]] atomically changes only legacy `default` rows to the claimed employee Profile; completion is then marked so another employee cannot inherit them. An interrupted pending claim is resumable, and the old `default` chat files remain recoverable.

#### One-time claim

The legacy default workspace can be claimed by one stable employee `user_id`; retries for that employee resume the same target, while a different employee receives an isolated fresh workspace.

### Employee workspace initialization tests

Offline tests cover position mapping, department-only non-inference, missing-position fallback, identity validation, stable Profile ids, managed-SOUL preservation, and binding publication.

#### Positionless current response

A payload without `position` creates a stable employee identity while leaving role state at `awaiting_position`, without inferring a job from `department`.

#### Current R&D mapping

The current API shape with `department: 研发部` and `position: 研发` configures the R&D role, writes that position into the managed employee SOUL, and binds the `research-development` Skill.

#### Existing Profile Skill repair

Repeating phone configuration refreshes maintained role Skills in an existing employee Profile before validation, while preserving unrelated Profile content.

#### Future project-manager mapping

A future project-manager title resolves to the maintained `project-manager` Skill through the role catalog compatibility seam.

#### Ready publication

Pending initialization remains invisible to Chat, while an atomic ready binding becomes readable only after commit.

#### Immediate Profile activation

A successful phone configuration activates its returned Profile and mandatory role Skills in the current renderer without requiring a page reload or application restart.

#### Dashboard handle release

Employee history publication waits for the managed Dashboard process to exit instead of treating a sent termination signal as proof that Windows has released `state.db`.

The provider list is data-driven from `PROVIDERS.setup` in [[src/renderer/src/constants.ts]]. Each entry carries an `envKey`, `configProvider`, `baseUrl`, and `needsKey`; selecting a card drives which form fields show (API key, or the Local server/base-URL flow).

## Company gateway fallback

Employee profiles can use AIHub Terra as a request-local backup when the company gateway is unavailable, without changing the saved model or other sessions.

The route is `https://aihub.dog/v1/responses`, model `gpt-5.6-terra`, protocol `codex_responses`. [[src/main/agent-config-providers.ts#mirrorCompanyFallbackProvider]] enables it only when the profile has both `CUSTOM_PROVIDER_COMPANY_PLATFORM_KEY` and `AIHUB_API_KEY`. Stable and beta workflows require `AIHUB_API_KEY` as a GitHub Actions Secret and write it into the managed Runtime archive, never tracked source or YAML. [[src/main/managed-aihub-key.ts#mergeBundledAihubKey]] adds it to each profile `.env` only when that profile has no nonempty value; employee auto-configuration also prefers the existing managed/profile value over an optional API response value.

[[src/main/agent-config-providers.ts#upsertAgentManagedFallback]] preserves other fallback entries, recognizes the managed entry after Python removes YAML comments, handles indentless lists, and reports unsupported nonempty flow lists without writing duplicate keys. Local Dashboard/gateway startup mirrors the route synchronously before spawning Python, avoiding reliance on renderer model-list timing. No fallback transition writes the selected/default model to disk.

### Trigger policy and first response budget

The company endpoint receives a 30-second first-event budget shared across a quick retry; healthy streaming is not limited to 30 seconds of total generation time.

Both company Chat Completions and Responses routes are covered. [[resources/hermes-agent-overlays/agent/desktop_fallback.py#should_switch]] immediately selects the backup after the first-response deadline, HTTP 429/502/503/504, or an unavailable model. HTTP 500 and connection errors allow one short retry. Truly empty output bypasses repeated empty retries. Eligible authentication failures follow the classification below. Generic request-format errors, context overflow, TLS verification, policy refusals, tool failures and user cancellation do not trigger transparent switching. An SSE opening/progress event counts as a response: this is not a 30-second promise of visible answer text. Existing idle/total watchdogs still apply after the first event.

The managed AIHub candidate is skipped for unrelated providers. It is tried within the current Agent using the existing provider-swap machinery, with the full conversation/tool-result context re-serialized for Responses; completed tools are not replayed. The Agent emits an actual backup-model notice. Primary restoration on a later turn follows the existing cooldown policy, rather than alternating providers within a tool workflow.

### Authentication and permission classification

HTTP 401 can use the independently credentialed backup; HTTP 403 requires explicit model-access or disabled-account evidence. Safety refusal always takes precedence over an authentication signal.

[[resources/hermes-agent-overlays/agent/desktop_fallback.py#record_error]] reads error `code`, `type`, and `message`, including nested error objects, JSON strings and response JSON. Exact permission/account codes are preferred; narrow English and Chinese descriptions are the fallback for generic gateway envelopes. Generic Forbidden, permission_denied, region/IP blocks and HTML interception pages are not sufficient to enable 403 failover. No network probe or LLM classifier is used.

Only the status and sanitized classification remain on the current Agent and are reset before the next request. Eligible auth transitions log a category and display an authentication/permission notice, not the upstream body or credentials. Both the retry decision and final provider-activation gate use the same result. HTTP-200 content-filter and truncated content-filter branches explicitly retain their policy signal so legacy no-reason calls cannot bypass the exclusion. Other providers and request-cancellation behavior are unchanged.

### Request cancellation and runtime distribution

The old request must finish closing before a backup request starts, preventing concurrent workers from writing to one session or overwriting its client state.

[[resources/hermes-agent-overlays/agent/desktop_fallback.py#abort_for_fallback]] sets a request-local cancellation flag, aborts only its worker-owned socket and joins the worker. If it does not exit, the turn reports a bounded failure instead of starting another provider; subsequent calls are guarded until that worker exits. A partial visible answer is not transparently mixed with another provider's answer. Protocol-independent conversation-loop changes do not add a second scheduler or global model-switch state.

`scripts/patch-company-fallback-safety.mjs` adds the watchdog and policy gates to the vendored runtime. `scripts/prepare-dev-agent.mjs` installs the same helper and patches in development; the release workflow applies the overlay before packaging. The staged Python helper is included alongside the patched modules, so no runtime-only import is missing in the installer.

### Offline policy and cancellation tests

Offline tests verify 30-second budgets, immediate versus retryable errors, excluded errors, partial output, secret scope, and safe worker shutdown without calling paid model APIs.

`tests/skills/test_company_fallback.py` exercises actual background-worker polling with shortened test deadlines, verifies that a first SSE event permits a longer response, and checks fail-closed behavior for a worker that cannot terminate. TypeScript tests cover config idempotency, Python-style YAML rewrites, missing credentials, secret-free YAML and development/packaging patch application. These are local regression tests, not a live outage test of the external gateways.

### Authentication and permission classification tests

Offline fixtures verify eligible 401/403 errors, safety precedence, ambiguous Forbidden and HTML rejection, request isolation, and the unchanged backup-key, partial-output and cancellation guards.

Tests use the runtime's existing error classifier plus the desktop policy and final activation gate. Packaging checks ensure the new error capture and both legacy refusal guards are applied idempotently to development and release runtimes. No live credentials or paid requests are required.

## JingYuAI is the first-priority provider

**JingYuAI Inference** is the first visible OpenAI-compatible gateway in provider pickers, while its existing Hermes One endpoint and identifiers remain unchanged for compatibility.

It routes through `custom` + `base_url`, retains `HERMESONE_API_KEY`, `inference.hermesone.org`, and the internal `hermesone` provider ID, and reverse-maps back to the JingYuAI card on reload. `detectBrand` still matches `hermesone` but renders `jingyuai-icon.png`.

## Top grid mirrors the agent's native providers

The top provider grid shows only providers the upstream agent supports natively; generic OpenAI-compatible endpoints live in the Local presets instead.

The source of truth is `CANONICAL_PROVIDERS` in the bundled agent (`hermes-agent/hermes_cli/models.py`) — the registry of providers with first-class auth/base-URL handling (nous, openrouter, anthropic, openai-codex, openai-api, gemini, xai, xiaomi, ollama-cloud, deepseek, …). A card belongs in the top grid only if it maps to a canonical slug. `aimlapi` was removed from the grid because it has no canonical entry; it remains reachable as a **Local → Remote OpenAI-Compatible APIs** preset.

DashScope API-key traffic uses the agent's native `alibaba` provider. The agent itself aliases `qwen` (and `dashscope`, `aliyun`, `alibaba-cloud`) to `alibaba`; only `qwen-oauth` is the Qwen Portal OAuth provider. DashScope hosts resolve to `alibaba` and `DASHSCOPE_API_KEY`, and legacy configs that still say `provider: qwen` keep working: the install-gate env map covers every alias, and `displayProviderFromConfig` lands them on the DashScope card.

DashScope users choose between the mainland China and international endpoints during first-run setup ([[src/renderer/src/screens/Setup/Setup.tsx]]). Both choices keep `provider: alibaba`; only `base_url` changes. The **Setup picker** defaults to mainland China (`DEFAULT_DASHSCOPE_BASE_URL`) and always writes `base_url` explicitly, but the **canonical registry** ([[src/main/provider-registry.ts]] `PROVIDER_BASE_URLS`) stays on the international endpoint because it mirrors the agent's own default and is what `setModelConfig` fills into an empty `base_url` — a CN value there would silently repoint existing international users. The Providers tab has no endpoint field anymore (the active model is picked from configured providers), so `confirmModelPick` preserves the current `base_url` when re-picking an `alibaba` model — dropping it to empty would let the canonical fill flip a mainland user to the intl endpoint.

## OpenAI-compatible endpoints route through Local

Endpoints the agent does not natively support (Groq, DeepSeek, Together, Fireworks, Cerebras, AtlasCloud, Mistral, AIML, …) are offered as `LOCAL_PRESETS` chips under the `local` card, not as top-level cards.

Selecting a preset sets the base URL; the API-key env var is resolved by `resolveCustomEnvKey` — first an exact `LOCAL_PRESETS.envKey` match, then [[src/shared/url-key-map.ts]] by host. So a compatible provider configures correctly without a dedicated card (e.g. `api.aimlapi.com` → `AIMLAPI_API_KEY`).

## Active model is picked from configured providers

The Providers tab ([[src/renderer/src/screens/Providers/Providers.tsx]]) sets the default (active) model by choosing from what's already configured, not by free-form entry — there's no more provider chip grid, manual model/base-URL fields, or inline API-key input.

The screen is organized as two tabs: Providers and Auxiliary Tasks. There is no longer a standalone Models tab — models are managed only under each provider card (see "Models live under each provider" below), since the provider owns the base URL and key a per-model editor would otherwise duplicate. The Auxiliary Tasks tab renders [[src/renderer/src/components/AuxiliaryTasksSection.tsx]] (per-task model overrides), and a **Browse Registry** button in the model-section header opens [[src/renderer/src/components/RegistryBrowserModal.tsx]] to pick curated models into the library. A registry pick captures the model's context window/capabilities into a definition, then adds the attachment; its "already added" state is keyed by provider + endpoint + model id — matching [[src/main/models.ts#addModel]]'s dedup — so the same model id offered by two different custom endpoints can be added from each.

The **MODEL** section shows a read-only summary (logo + provider label + model). A **Change** button opens a picker modal with a **provider** picker (a custom `LogoSelect` — the brand logo renders inside the control and each option, which a native `<select>` can't do) and a native **model** dropdown. Confirming sets `modelProvider`/`modelName`/`modelBaseUrl`, which the existing debounced auto-save persists to `config.yaml` via `setModelConfig` (compat providers as `custom` + base_url). The **API key is resolved automatically** at runtime — the picker never asks for it.

That modal (`model-select-modal`) is styled **light-based** (no strokes): the container border, header/footer dividers, and control outlines are dropped in favor of filled controls (`--bg-elevated`, `--bg-hover` on hover/open) — matching the branded config modal's treatment. Crucially it sets `overflow: visible` (the base `.models-modal` clips with `overflow: hidden`), so the `LogoSelect` dropdown — which is absolutely positioned and can extend past the modal — isn't clipped; the menu itself caps at `max-height` and scrolls internally when the provider list is long. Without the override the lower providers were hidden and unreachable.

The provider list (`pickerProviders`) is sourced from the **configured providers** — the same set shown as LLM cards — NOT from which providers happen to have saved models: keyed FieldDef providers (`env[f.key]` set, in FieldDef order so Hermes One leads) plus named custom providers whose `customProviderEnvKey(label)` is set. So a freshly-keyed provider with no models yet still appears.

### Native keys without a setup card still route

Native-provider keys with no `PROVIDERS.setup` card carrying them (or only the OAuth variant, `envKey: ""`) must still resolve to their agent slug, or the picker silently drops them even with a key set — the Nous-missing-from-Change-modal bug.

[[src/renderer/src/constants.ts#providerRouteForEnvKey]] consults an explicit `NATIVE_ENV_KEY_ROUTES` table after the setup/preset lookups: `NOUS_API_KEY → nous`, `GLM_API_KEY → zai`, `KIMI_API_KEY → kimi-coding`, `MINIMAX_API_KEY → minimax`, `MINIMAX_CN_API_KEY → minimax-cn`, `NVIDIA_API_KEY → nvidia`, `OPENCODE_ZEN_API_KEY → opencode-zen`, `OPENCODE_GO_API_KEY → opencode-go`, `HF_TOKEN → huggingface`, and `PERPLEXITY_API_KEY → custom` + its compat base URL. Slugs and env vars mirror hermes-agent's own registry (`plugins/model-providers/*`). A test enforces the invariant that **no** LLM-section FieldDef falls through to the dead `custom` + empty-base-URL fallback (`tests/constants.test.ts`).

The **model** dropdown merges that provider's saved models with live discovery ([[src/renderer/src/hooks/useDiscoveredModels.ts#useDiscoveredModels]]) so a just-configured provider is immediately usable. On confirm, a discovered-only model is persisted via `addModel` first (so its key resolves and it reappears), and compat providers store `custom` + their `OPENAI_COMPATIBLE_BASE_URLS` base URL.

The debounced auto-save keeps a guard from the grid era that still applies: `saveModelConfig` skips persisting a `custom` selection whose `base_url` is empty (writing it would clobber config.yaml with a dead endpoint) — **unless** config.yaml already holds a custom endpoint, tracked by the `persistedCustomUrl` ref (refreshed on load and after each save). In that case the empty value IS persisted, so deliberately clearing a configured custom endpoint doesn't leave the UI (empty) and config.yaml (old URL) disagreeing after navigation/relaunch.

## LLM-provider keys are configured-only, via modals

The `SETTINGS_SECTIONS` "LLM Providers" section no longer renders a static key card for every known provider (an overwhelming wall of empty inputs). It shows only providers with a key set, plus an **Add provider** action.

[[src/renderer/src/components/ProviderKeysSection.tsx#ProviderKeysSection]] renders the configured cards + an Add tile; Add opens a searchable picker modal (logo per provider) → a per-provider config modal (key input with show/hide, **Remove provider**). It's a presentation layer over the same `env` state + `handleChange`/`handleBlur`/`handleRemove` handlers in [[src/renderer/src/screens/Providers/Providers.tsx]], so persistence is unchanged (`setEnv`); removing clears the env var.

Card and picker titles show the **plain provider name** ("Hermes One"), not the FieldDef's "… API Key" label — the section is a list of providers, and suffix-stripping the label isn't locale-safe. [[src/renderer/src/constants.ts#providerNameForEnvKey]] derives the display brand from the env key (via `providerRouteForEnvKey` + `displayBrandFromConfig`) and returns its `PROVIDERS.labels` entry, falling back to the FieldDef label for brandless keys; the picker search matches both the name and the full label. A test asserts every LLM-section key resolves to a name (`tests/constants.test.ts`).

### Branded config modal

The per-provider config modal (a keyed brand like Hermes One, not the custom flow) leads with the **provider logo tile + name + a verification pill** in the header, replacing the old key-icon-prefixed title.

The pill's text/tone comes from the same live discovery the models list uses, lifted out of the body: `ProviderModelsManager` takes `showStatus={false}` and reports `{tone,text}` + the saved-model count up via `onStatusChange`/`onModelCountChange`, so there's one discovery hook and no duplicate status line.

The **API key** shows as a masked preview (`maskKeyPreview` — leading scheme segment + last 4, dots between) with **Show** / **Replace** actions and a "used by N models" meta line, rather than a raw always-editable input. `replacingKey` state governs edit vs. preview: a keyed provider opens in preview (Replace swaps to the input), a fresh one opens straight in the input. Closing the modal (Done, ✕, or overlay click) flushes the key through `onBlur` first. The **Models** list drops the separate add row for a **+ Add model ID** pill that swaps to an inline autocomplete input (Enter/blur commits, Escape cancels), and each model chip's id is itself the click target for the definition editor. Only the first `MODELS_COLLAPSED` (10) chips render; the rest collapse behind a **+N more** toggle (`showAllModels`) so a large catalog doesn't flood the modal.

Visually the modal is **stroke-free**: the logo tile, status pill, API-key field, model chips, and the add/more pills are all differentiated by fill/elevation (`--bg-elevated`/`--bg-hover`), not borders — only the header/footer keep a hairline divider for structure. Chip and control fonts are small (11–13px).

The cards and picker are **ordered by display priority**, not the FieldDef declaration order (which groups providers by when they were added, surfacing niche endpoints like AIML API near the top). [[src/renderer/src/constants.ts#providerKeyRank]] ranks each env key: `PROVIDER_KEY_ORDER` front-loads the well-known providers (Hermes One first), unlisted keys keep their FieldDef order in the middle, and `PROVIDER_KEY_DEMOTED` (AIML API) sinks to the end. `ProviderKeysSection` sorts `keyItems` with a **stable** sort on the rank, so both the configured cards and the Add-provider picker share the ordering. A test pins Hermes One first and AIML last.

The section is rendered **standalone, above the credential pool** rather than in the `SETTINGS_SECTIONS.map` position — it's the primary surface for configuring providers and the models the top active-model selector picks from, so it sits before the advanced multi-key pool. The map skips the `constants.sectionLlmProviders` entry (an inline title check returning null); other `SETTINGS_SECTIONS` (non-LLM) still render inline in place, after the pool.

### Named custom providers

The picker offers a **Custom provider** tile (last) for any OpenAI-compatible endpoint not covered by a built-in card. You can add **multiple**, each with a distinct name, base URL, and its own key.

A custom provider's **identity** (name + base URL) is a first-class record in the desktop's per-profile store [[src/main/providers-store.ts]] (`providers.json`, plaintext — it holds no secrets, only name + base URL). Its **key** still lives in the profile `.env` and its **models** in `models.json`; the store is _additive_ so a provider renders as a card the moment it is saved, independent of whether any model has been added. This fixed the prior gap where a keyed-but-modelless provider was invisible.

The config modal collects **Name**, **Base URL**, and an API key. On save (modal close) the identity is upserted via `upsertCustomProvider` ([[src/main/providers-store.ts#upsertCustomProvider]]), deduped by the derived env-key anchor so a re-save updates in place. The key is stored under the provider's dedicated env var, [[src/shared/url-key-map.ts#customProviderEnvKey]]`(name)` → `CUSTOM_PROVIDER_<SANITISED_NAME>_KEY` — so two custom providers never share a key. Models are added through the same [[src/renderer/src/components/ProviderKeysSection.tsx#ProviderModelsManager]] with an explicit `{ provider: "custom", baseUrl }` route plus `providerLabel = name`; that label is persisted on each [[src/main/models.ts#SavedModel]] (`providerLabel`) via [[src/main/models.ts#addModel]] (whose dedup now includes base URL, so the same model id can exist under two endpoints).

Configured custom-provider cards are the **union** of three sources, deduped by env-key anchor (in [[src/renderer/src/components/ProviderKeysSection.tsx#ProviderKeysSection]]): (1) the authoritative `providers.json` records via `listCustomProviders`; (2) back-compat — `provider: "custom"` models in `models.json` whose host resolves to `CUSTOM_API_KEY` (known compat hosts like groq/hermesone are excluded — they own dedicated key cards), grouped by `providerLabel`; (3) **orphan recovery** — any `CUSTOM_PROVIDER_*_KEY` env var with a value but no record/model, surfaced with an empty base URL so the user can complete or remove it. The active-model picker in [[src/renderer/src/screens/Providers/Providers.tsx]] unions (1) with the models-derived labels too, so a keyed custom provider is selectable before a model is saved; it prefers the authoritative `providers.json` base URL over a saved model's URL, so editing an existing provider's endpoint reroutes newly picked models instead of pinning them to the stale URL (a saved model's URL is used only for legacy/orphan records whose stored base URL is blank). **Remove provider** deletes its models, drops its `providers.json` record (`removeCustomProvider`), and clears its `CUSTOM_PROVIDER_*` key. The runtime is unchanged: [[src/main/hermes.ts]] still looks up the base-URL-matched model and derives `customProviderEnvKey(providerLabel ?? name)`, so every model under a provider shares that provider's key.

### Adding a curated partner provider

Sponsor/partner providers (and Hermes One itself) are OpenAI-compatible custom endpoints under the hood but are presented **first-class** — curated in-app, exactly like `hermesone`, with their own host-derived key and branding.

To add one, mirror the Hermes One entries: a card in `PROVIDERS.setup` + `PROVIDER_CARDS` + a base URL in `OPENAI_COMPATIBLE_BASE_URLS` ([[src/renderer/src/constants.ts]]), a `URL_KEY_MAP` entry giving it a dedicated `<PARTNER>_API_KEY` in [[src/shared/url-key-map.ts]], and a `detectBrand` rule + logo in [[src/renderer/src/components/common/BrandLogo.tsx]].

## Agent config sync for named providers

Named OpenAI-compatible providers sync both ways between the desktop and the agent's config.yaml — a CLI-added provider appears in the desktop UI, and a desktop-added one is visible to `hermes model` / `--provider <slug>`.

### Company Responses request identity

The employee GPT Responses route replaces the OpenAI Python SDK User-Agent with `JingYu-Desktop`, because the company gateway stalls SDK-identified requests even when the same body succeeds from a neutral HTTP client.

The override runs in the Agent client-header lifecycle only when the resolved provider is `company-platform-responses` and `api_mode` is `codex_responses`. It is applied after generic header merging, preserves other headers, and ships through development and packaged-runtime preparation. The `company-platform` chat route shares the URL but cannot inherit the override, so DeepSeek and unrelated providers retain their existing request behavior.

The agent reads two user-config shapes (`hermes-agent/hermes_cli/providers.py`): the `providers:` dict (`{slug: {name, base_url, key_env, transport}}`, resolved by `resolve_user_provider`) and the legacy `custom_providers:` list. [[src/main/agent-config-providers.ts]] is the bridge: it parses and text-edits those blocks with offset/line splicing (like `config.ts`), so user comments and unrelated keys survive round-trips.

The agent's config scaffold writes an inline empty dict (`providers: {}`), which the line-based block parser can't index — the upsert rewrites that line into block form instead of appending (a second `providers:` key would make the YAML ambiguous; this miss silently disabled the Hermes One mirror on real configs). Any other unparseable flow-dict form is left untouched rather than risking a duplicate key.

Sync is read-repair plus write-mirroring, all in the main process — the renderer needed no changes:

- **Import (terminal → desktop)**: every [[src/main/providers-store.ts#listCustomProviders]] read first runs the import — each config.yaml `providers:` entry is upserted into `providers.json` (skipping hosts that own a dedicated brand card), and a terminal `key_env`'s value is aliased additively to the derived `CUSTOM_PROVIDER_<NAME>_KEY` so the desktop key field and the runtime's label-derived lookup resolve unchanged. Similarly [[src/main/models.ts#syncAgentConfigModels]] merges `custom_providers:` model entries into `models.json` on every [[src/main/models.ts#listModels]] call (not just first seed), deduped by provider + model id + base URL, tagging rows with `providerLabel` so cards group correctly.
- **Mirror (desktop → terminal)**: [[src/main/providers-store.ts#upsertCustomProvider]] upserts a matching `providers:` entry (`name`/`base_url`/`key_env: CUSTOM_PROVIDER_<NAME>_KEY`) via [[src/main/agent-config-providers.ts#upsertAgentUserProvider]] — matching an existing entry by `key_env` then slug, and patching field values in place so a terminal user's extra fields (e.g. `transport:`) survive. [[src/main/providers-store.ts#removeCustomProvider]] removes the entry from **both** config.yaml shapes so the next read can't re-import a deleted provider.

Config.yaml is effectively the shared source of truth: desktop edits land there, and imports copy it back into the desktop stores. All writes are best-effort (an unwritable config.yaml never breaks the desktop store) and idempotent (unchanged content is never rewritten).

### Parses the agent's providers dict

`listAgentUserProviders` reads `providers:` entries with the same `base_url`/`api`/`url` alias precedence and `key_env` handling as the agent's `resolve_user_provider`, scoped by indentation so nested maps can't shadow the identity fields.

### Desktop saves mirror into config.yaml

`upsertAgentUserProvider` appends a `providers:` block (creating config.yaml or the block when missing) and round-trips through the parser; unrelated top-level keys are untouched.

### Store upserts propagate to the agent config

A desktop `upsertCustomProvider` leaves a terminal-visible `providers:` entry carrying the provider's derived `CUSTOM_PROVIDER_<NAME>_KEY` as `key_env`.

### Terminal-added providers import on read

A config.yaml `providers:` entry surfaces as a desktop provider card/record on the next list read, with its custom `key_env` value aliased additively into the derived env var; entries pointing at dedicated-brand hosts (e.g. Groq) are skipped.

### Model library merges custom_providers on every read

`custom_providers:` entries added from the terminal **after** the library was first seeded appear via `listModels`, exactly once (idempotent dedup), with their API key persisted under the derived env var.

### Desktop deletion cleans the agent config

Removing a provider in the desktop also deletes its `providers:` entry, so it stays deleted instead of re-importing on the next read.

### Legacy custom_providers removal

`removeAgentCustomProviderEntry` drops a `custom_providers:` list item by display name while leaving sibling items and following top-level blocks intact.

### First-party brands mirror as user providers

A keyed Hermes One is mirrored into config.yaml as `providers: hermesone:` ([[src/main/agent-config-providers.ts#mirrorFirstPartyAgentProviders]], run on every model-library / provider-list read) — without creating a custom card, since the brand owns a dedicated key card.

This exists because desktop models on `inference.hermesone.org` are saved as bare `custom` + base URL, and the agent resolves `/model … --provider custom` against the **session's current** base URL — a session sitting on another provider (e.g. Nous) would send the Hermes One model to the wrong endpoint (the hermesone-swift → Nous-proxy 404). The named entry gives the switch a slug that always carries the right URL and `HERMESONE_API_KEY`; the dashboard transport asks the packaged gateway's local-only `model.resolve` method to match configured Provider rows by base URL before falling back to bare `custom`, without waiting for live model inventory.

### Matching live custom models avoid redundant named switches

When a fresh Dashboard session already reports the requested bare `custom` model, the transport reuses it instead of switching to a mirrored named provider for the same endpoint.

This preserves the endpoint inherited from the desktop config and avoids a redundant `/model --provider <slug>` validation. Generic named-provider validation may reject hidden or aliased models omitted by a proxy's `/v1/models`, while the already-active custom route can serve them.

### Private custom gateways retain their named-provider credentials

Selecting a saved custom model on an unrecognised/private endpoint restores its named-provider key into `model.api_key`, so the agent's bare `custom` route remains authenticated after the desktop sync rewrites the model block.

## Models live under each provider (OpenCode-style)

A provider's config modal manages the models it serves — the **only** place models are added/edited, since there is no standalone Models screen. The provider→models hierarchy lives in one place instead of a separate flat list.

[[src/renderer/src/components/ProviderKeysSection.tsx#ProviderModelsManager]] renders below the key field in the config modal: a key-status line, the model pills, and an add-input. It reads/writes the same `models.json` library the chat picker reads (`listModels`/`addModel`/`removeModel`, and re-syncs on `onModelLibraryChanged`), so added models immediately appear in the chat model picker. Models show as chips with a remove button and a **pencil** that opens a small editor for the model's shared definition (display name + context window — see [[model-context]]); because the definition is keyed by model id, editing it under one provider reflects under every provider serving that id. The add-input autocompletes off live discovery and strips whitespace as typed/pasted (model IDs never contain spaces, so `"hello there"` can't be saved).

The single [[src/renderer/src/hooks/useDiscoveredModels.ts#useDiscoveredModels]] call does double duty: it feeds the add-input's `<datalist>` **and** drives the "Connected · key verified" status line — a `status: "ok"` means the endpoint accepted the key and returned a model list, so the "verified" claim is truthful. `unsupported`/`unknown-host` degrade to a plain "Connected" (key set, list not exposed), `error` to "Couldn't verify key", and an empty key to "Add a key to connect".

The env key is the only anchor the modal has, so persistence routing is derived from it by [[src/renderer/src/constants.ts#providerRouteForEnvKey]]: it scans `PROVIDERS.setup` (returning `{provider: configProvider ?? id, baseUrl}`) then `LOCAL_PRESETS` (always `custom` + `baseUrl`), falling back to a bare `custom` route. Native providers keep their agent slug (the gateway hardcodes the base URL); OpenAI-compatible providers save as `provider: "custom"` + explicit `baseUrl` — the same routing the Providers tab's active-model picker applies, so entries stay consistent regardless of where they were added.

DashScope is a native provider rather than a compatible/custom endpoint, but it follows the same inline editing pattern: the endpoint selector writes either `dashscope.aliyuncs.com` or `dashscope-intl.aliyuncs.com` to `base_url`, and the key field writes `DASHSCOPE_API_KEY`.

Ids the agent can't resolve by id are listed in `OPENAI_COMPATIBLE_BASE_URLS` ([[src/renderer/src/constants.ts]]) — openai, perplexity, and every `LOCAL_PRESETS` chip (local servers + remote endpoints like groq, deepseek, atlascloud, mistral, …). This map MUST contain every preset id, or selecting that chip mis-routes; a test in `tests/constants.test.ts` enforces it. Selecting one autofills its base URL and shows the base-URL field; on save it is persisted as `provider: custom` + `base_url`, which the gateway accepts and uses to host-derive the API key (`runtime_provider._host_derived_api_key`, e.g. `api.groq.com` → `GROQ_API_KEY`). `displayProviderFromConfig` reverse-maps a stored `custom` + known base URL back to the brand id so the dropdown re-selects it on load. Native providers (the gateway hardcodes their base URL) clear the field instead.

## Switching providers rewrites the transport (`api_mode`)

Activating a model must rewrite or clear `model.api_mode`, or a stale protocol from the previous model routes the new endpoint over the wrong transport — dropping connections when switching OpenAI- and Anthropic-compatible custom endpoints.

The gateway's runtime-provider resolver honors a persisted `model.api_mode` (`anthropic_messages` vs `chat_completions`, …) for `custom`/compatible providers, and only auto-detects from the base URL (`/anthropic` suffix, `api.openai.com`, …) when the key is absent. So a leftover `anthropic_messages` would keep an OpenAI-compatible endpoint pointed at `/v1/messages` (404 / lost connection).

[[src/main/config.ts#setModelConfig]] takes an optional `apiMode` argument, handled exactly like `context_length`: a non-empty string sets `model.api_mode`, `null`/empty removes it (so auto-detection resumes), `undefined` leaves it untouched. The `set-model-config` IPC handler ([[src/main/ipc/register.ts]]) resolves it from the activated model's `apiMode` library field ([[src/main/models.ts#SavedModel]]) — `null` when the entry has none — alongside the `contextLength` mirror, on both the pure-local and remote-fallback local writes. Custom-provider library entries carry `apiMode` because `loadCustomProviders` reads `api_mode` from each `custom_providers:` block.

The library lookup runs through [[src/main/ipc/register.ts#resolveLibraryModelEntry]], which disambiguates by base URL when several entries share the same provider+model — e.g. two `custom` endpoints exposing the same model id over different transports. A bare provider+model match would return the first entry and persist its `api_mode` for the other endpoint, routing it over the wrong protocol; matching the base URL too keeps each endpoint's transport correct. Single-entry activations are unaffected.

## Provider icons

Each card's logo is resolved by [[src/renderer/src/components/common/BrandLogo.tsx]] from the provider id, falling back to a generic robot for unknown ids.

`detectBrand` matches the provider/model string to a `BrandKey`, and `matchTheme` flattens every logo to a single white/black tint so colored and `currentColor` SVGs render uniformly in the grid's logo tiles.

The Local/Remote preset chips are also branded: each renders the same `BrandLogo` (by preset id) to the left of its name in a row. `llama.cpp` is mapped off the Meta logo to the generic API mark (the `/llama/` substring would otherwise tag it, and Ollama, as Meta); any preset without a bundled logo falls back to the generic mark.
