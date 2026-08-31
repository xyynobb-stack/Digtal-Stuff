# Desktop Updates

Desktop automatic updates use Windows NSIS packages mirrored onto the company intranet update service. GitHub Releases remain the build artifact source, while unsigned macOS builds are published separately for manual installation.

The packaged `electron-updater` feed is generated from `electron-builder.yml` as the generic URL `http://192.168.2.254/jingyuai-updates`. Each stable GitHub build still publishes the matching `latest.yml`, NSIS setup executable, and blockmap; operators copy that immutable set to the intranet service, publishing `latest.yml` last so clients never observe metadata before its payloads. [[src/main/app/updater.ts#setupUpdater]] persists the auto-download preference under Electron `userData` and disables updates for development, portable execution, and unsigned manual macOS builds.

When the intranet feed reports a newer release, [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] shows an upgrade button in the sidebar footer. The button downloads the update when needed, shows progress, and becomes a restart action after the update is ready.

An `update-not-available` result is a successful check and clears stale footer state instead of appearing as an error. Background startup-check failures stay in the updater log rather than creating a permanent sidebar warning; manual check/download failures remain visible and dismissible. [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] applies the same distinction in About settings.

[[src/renderer/src/components/settings/AboutPane.tsx#AboutPane]] presents JingYuAI Desktop separately from the compatible Agent engine because they use independent update channels. [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] drives version, preference, download, and restart actions.

## Stable and beta release channels

Stable and beta workflows build Windows x64 NSIS installers; only the stable channel is visible to installed production clients.

`.github/workflows/release.yml` runs on pushes to `release`, reads `package.json`, builds the Windows installer, and publishes `latest.yml`, the setup executable, and its blockmap. Normal versions become stable GitHub Releases; hyphenated diagnostic versions such as `0.7.43-test.1` are marked as prereleases so production clients ignore them.

Stable pushes must advance the version in both `package.json` and the root package entries of `package-lock.json`: the workflow skips builds when the matching `v<version>` tag already exists. Runtime fallback code ships with the overlays, but AIHub credentials are provisioned separately per installed profile, as described in [[provider-setup#Company gateway fallback]].

Before building the bundled Dashboard, both workflows apply the repository-owned Agent overlays to the committed offline runtime and verify the cold-start model/session RPCs. This keeps packaged behavior aligned with overlay sources without rebuilding the environment-specific runtime snapshot.

`.github/workflows/beta-release.yml` runs on pushes to `beta` or manual dispatch, stamps a `-beta.<run>` prerelease version, and publishes the equivalent Windows artifacts with `beta.yml`.

The updater leaves `allowPrerelease` disabled, so stable clients ignore beta prereleases. Testers install beta builds manually from the prerelease page.

## Manual macOS builds

`.github/workflows/build-macos.yml` manually builds unsigned Intel and Apple Silicon DMG/ZIP packages with the bundled runtime.

It publishes them under an independent `mac-build-<run>` prerelease for manual installation. These builds do not check or install application updates.

## Bundled runtime updates

The installers include the managed Hermes Agent and matching Python runtime under `hermes-runtime`, allowing first launch without downloading the runtime separately.

Windows release jobs package the complete staged Runtime as one `runtime.tar` plus a SHA-256/size sidecar and build marker. NSIS therefore installs three Runtime resource files rather than expanding the Python environment itself. First launch performs the one necessary expansion into the immutable version directory, verifies archive integrity and Runtime probes, and atomically activates it as described in [[main-process#Offline Windows runtime#Single Runtime archive]].

Windows packages also include full PortableGit. Local staging and both release channels download the pinned distribution into `build/offline-runtime/git`; archive extraction places it beside Agent and Python in the active immutable Runtime. Staging falls back to copy-and-remove when CI temporary files and the repository are on different Windows volumes.

Windows CI rebuilds the ignored virtual environment with `pip install -e .` and injects the employee lookup secret without committing it. Because editable metadata records the CI checkout path, first-launch Runtime preparation writes a scoped `.pth` entry for the relocated managed Agent, and Dashboard startup also prepends that Agent root to `PYTHONPATH`. This preserves the neutral backend cwd that prevents bundled `AGENTS.md` discovery while keeping `hermes_cli` importable. Stable and beta workflows reject incomplete Python, Agent, PortableGit, or environment resources.

Stable and beta builds also replace the committed base Python's SQLite DLL through the pinned official download described in [[main-process#Offline Windows runtime#Pinned SQLite runtime]]. SQLite archive integrity, the imported version, and WAL activation are verified before Runtime archiving; packaged-resource verification then checks the Runtime archive manifest and required entry list.

Installed runtimes are immutable version directories keyed by the app version and packaged runtime marker. Upgrades stop tracked gateway/dashboard processes, stage and structurally validate the new tree in a private sibling, atomically rename it, repair Python paths against the final directory, and require an executable probe before switching `active-runtime.json`; no active venv can retain a deleted `.staging-*` path. The dashboard records its PID beside each profile, and Windows process discovery under the managed runtime root covers older builds that predate that marker.

If staging, validation, process shutdown, or the active switch fails, startup preserves the previous version and raises a runtime-upgrade error. The renderer shows a dedicated retry screen instead of interpreting the failure as an uninstalled Agent and silently returning to Welcome. Backend and renderer guards prevent packaged managed runtimes from entering the generic network installer, which is reserved for development/manual layouts.

Offline staging excludes the Agent repository's top-level development `assets` only; nested runtime directories such as `hermes_cli/web_dist/assets` remain part of the package. Stable and beta workflows build the Dashboard frontend and verify that every JS/CSS file referenced by `index.html` exists both before and after Electron packaging, preventing a partial SPA from crashing the API/WebSocket server during startup.

Installed NSIS builds may update this bundled runtime together with the Electron app. Development, portable execution, and macOS remain excluded from automatic updates by [[src/main/app/updater.ts#setupUpdater]].

The first build that enables this channel must be installed manually on existing employee devices because older bundled builds disabled their updater. Later stable versions can update through GitHub Releases.
