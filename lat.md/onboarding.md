# Onboarding Chrome

The first-run screens share a cinematic dark shell with an animated JingYuAI mark provided by [[src/renderer/src/components/common/OnboardHero.tsx#OnboardHero]].

## OnboardHero

[[src/renderer/src/components/common/OnboardHero.tsx#OnboardHero]] renders aurora, vignette, starfield, the JingYuAI icon, an uppercase `eyebrow`, an upright `title`, and page-specific content.

Props: `eyebrow`, `title`, `children`, `intro` (play the full intro), `wide` (widen the column for the installing terminal). All visual tokens live under the `ONBOARDING HERO (shared)` block in `main.css`.

The screens are `user-select: none` chrome; only `input`, `textarea`, `code`, and `[data-selectable]` stay selectable (so the install path and log can still be copied).

### Intro choreography

When `intro` is set, the JingYuAI icon establishes itself in the centre, then flies up and shrinks into its settled slot before the content cascades in.

The component holds a `phase` of `draw → settle → done`. At `DRAW_MS` it measures the settled icon, moves the flying bitmap into that slot, then removes the overlay at `DRAW_MS + SETTLE_MS` and reveals the content. Reduced-motion mode skips the flight.

## Welcome

[[src/renderer/src/screens/Welcome/Welcome.tsx#Welcome]] is the default first-run view. Its no-error state renders through `OnboardHero intro`.

The hero carries the "JINGYUAI" eyebrow, localized JingYuAI title, a gradient "Get Started" pill, and glass SSH/remote-connect actions. Error and connection panels keep the legacy `.welcome-screen` layout.

## Install confirm + progress

[[src/renderer/src/screens/Install/Install.tsx#Install]] renders both the pre-install confirmation and the running progress through `OnboardHero` (no intro — the emblem fades in place).

The confirm view (eyebrow "SETUP", title "Before installing") shows the target path in an `.onboard-field`, a `.onboard-note-card` describing the fresh/update/replace state, and Install / Use-existing / Cancel actions.

The progress view (`wide`) shows a step + percent header with a progress bar, then a **fixed-size** terminal log window (`.onboard-terminal`): its body has a constant height and scrolls internally, so streaming log lines never reflow the surrounding layout. The log auto-scrolls to the newest line.

## Employee phone provisioning

The Providers screen displays the current Profile's persisted employee binding and granted models, independently of browser storage; Setup retains its onboarding history.

[[src/renderer/src/screens/Setup/Setup.tsx#Setup]] and [[src/renderer/src/screens/Providers/Providers.tsx#Providers]] still record successful configuration through [[src/renderer/src/utils/employeePhones.ts#rememberConfiguredEmployee]], but this history is not an authority for the Providers card or Feishu identity. Providers loads explicit Profile details over IPC and rejects stale responses after switching. Provisioning also sets the Profile display name from the API `real_name` value.

## Startup splash

The first frame is [[src/renderer/src/screens/SplashScreen/SplashScreen.tsx]], pairing the shared JingYuAI icon with its wordmark while [[src/renderer/src/App.tsx#App]] runs install checks. It retains the local-mode escape hatch.
