# Desktop Branding

The desktop presents the JingYuAI name and supplied blue-purple mark while retaining Hermes-compatible runtime identifiers behind the UI.

## Visible identity

Every user-facing shell surface uses JingYuAI, including window and notification titles, installer metadata, onboarding, default avatars, provider cards, About, exported transcripts, and the 3D office.

New local and SSH profiles also receive a default SOUL identity of JingYuAI, while existing user-authored SOUL files remain untouched.

The renderer title fallback lives in [[src/renderer/src/main.tsx]], while the native title and notification fallback live in [[src/main/app/start.ts#startMainProcess]] and [[src/main/ipc/register.ts#registerIpcHandlers]]. Packaging uses the same name and generated platform icons under `build/`.

## Default language

Fresh installations open in Simplified Chinese, while an explicit locale previously saved by the user remains authoritative.

[[src/shared/i18n/config.ts]] defines the fresh-profile default. Visible navigation, reasoning controls, appearance settings, theme names, hardware acceleration controls, and the profile entry use translation keys rather than embedded English; in Chinese, `Profile` is rendered as “个人资料”.

## Shared image assets

One square PNG is the renderer and native-window source of truth so the splash, onboarding, chat empty state, title bar, profile fallback, About pane, and first-party provider card display the same mark.

[[src/renderer/src/components/common/HermesLogo.tsx#HermesLogo]] and [[src/renderer/src/components/common/BrandLogo.tsx]] consume `jingyuai-icon.png`. [[src/renderer/src/screens/Chat/ChatEmptyState.tsx#ChatEmptyState]] renders the shared logo instead of the legacy wordmark mask, while [[src/main/app/start.ts#createWindow]] supplies the matching PNG to non-macOS native windows. [[src/renderer/src/components/common/OnboardHero.tsx#OnboardHero]] flies that bitmap into its settled slot instead of embedding a separate SVG path.

## Compatibility boundary

Branding changes do not rename storage, IPC, CLI, provider, environment-variable, or remote-protocol identifiers because existing installations and the bundled Agent depend on them.

Identifiers such as `window.hermesAPI`, `.hermes`, the `hermes` CLI, `HERMES_HOME`, `HERMESONE_API_KEY`, `hermesone`, Hermes session headers, and existing backend domains remain implementation details. Existing social and service URLs also remain until JingYuAI-owned endpoints are supplied.
