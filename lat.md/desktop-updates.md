# Desktop Updates

Desktop automatic updates use Windows NSIS packages from the project's own GitHub Releases. Unsigned macOS builds are published separately for manual installation.

The Electron main process configures `electron-updater` from `electron-builder.yml`, which points at `xyynobb-stack/Digtal-Stuff`. [[src/main/app/updater.ts#setupUpdater]] persists the auto-download preference under Electron `userData` and disables updates for development, portable execution, and unsigned manual macOS builds.

When GitHub reports a newer release, [[src/renderer/src/screens/Layout/Layout.tsx#Layout]] shows an upgrade button in the sidebar footer. The button downloads the update when needed, shows progress, and becomes a restart action after the update is ready.

[[src/renderer/src/components/settings/AboutPane.tsx#AboutPane]] presents JingYuAI Desktop separately from the compatible Agent engine because they use independent update channels. [[src/renderer/src/components/settings/useSettingsData.ts#useSettingsData]] drives version, preference, download, and restart actions.

## Stable and beta release channels

Stable and beta workflows build Windows x64 NSIS installers; only the stable channel is visible to installed production clients.

`.github/workflows/release.yml` runs on pushes to `release`, reads `package.json`, builds the Windows installer, and publishes a normal GitHub Release with `latest.yml`, the setup executable, and its blockmap.

`.github/workflows/beta-release.yml` runs on pushes to `beta` or manual dispatch, stamps a `-beta.<run>` prerelease version, and publishes the equivalent Windows artifacts with `beta.yml`.

The updater leaves `allowPrerelease` disabled, so stable clients ignore beta prereleases. Testers install beta builds manually from the prerelease page.

## Manual macOS builds

`.github/workflows/build-macos.yml` manually builds unsigned Intel and Apple Silicon DMG/ZIP packages with the bundled runtime.

It publishes them under an independent `mac-build-<run>` prerelease for manual installation. These builds do not check or install application updates.

## Bundled runtime updates

The installers include the managed Hermes Agent and matching Python runtime under `hermes-runtime`, allowing first launch without downloading the runtime separately.

Windows packages also include full PortableGit. Local staging and both release channels download the pinned distribution into `build/offline-runtime/git`; Agent processes use it directly from packaged resources without a second copy in user data.

Windows CI rebuilds the ignored virtual environment with `pip install -e .` and injects the employee lookup secret without committing it. Stable and beta workflows reject incomplete Python, Agent, PortableGit, or environment resources.

Installed NSIS builds may update this bundled runtime together with the Electron app. Development, portable execution, and macOS remain excluded from automatic updates by [[src/main/app/updater.ts#setupUpdater]].

The first build that enables this channel must be installed manually on existing employee devices because older bundled builds disabled their updater. Later stable versions can update through GitHub Releases.
