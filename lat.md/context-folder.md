# Linked working folder

A conversation can bind a working folder for source context while independently choosing where newly generated deliverables are saved.

## Desktop-only persistence

The folder isn't part of hermes-agent's session schema, so it lives in a desktop-owned table in the active profile's `state.db`, keyed by `session_id`.

[[src/main/session-context-folder-store.ts]] holds `desktop_session_context_folders` (mirroring [[src/main/session-continuation-store.ts]]). [[src/main/session-context-folder-store.ts#setSessionContextSettings]] atomically stores the folder and output preference, while the older folder-only APIs remain compatible. The row is dropped with the rest of a session's data in [[src/main/sessions.ts#deleteSessionRows]] so a deleted session leaves no orphan binding.

## Restore and save in the chat

The chat loads the stored folder when resuming a session and saves it whenever it changes, once the conversation has a gateway session id.

In [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] a load effect fetches both settings for `initialSessionId`; a save effect writes them as one snapshot. The save is gated until restore finishes, and a user-intent revision prevents a late restore response from overwriting a folder or output choice clicked while restore was in flight.

## Output destination

Local chats save newly generated user deliverables to the OS Desktop by default and can instead target the selected context folder; source edits and temporary files keep their original semantics.

[[src/main/ipc/register.ts#registerIpcHandlers]] resolves the Desktop through Electron's `app.getPath("desktop")`, including redirected Desktop folders. [[src/renderer/src/screens/Chat/ContextFolderChip.tsx#ContextFolderChip]] places the output choice in the existing folder menu and shows the active destination beside a selected folder. Remote and SSH chats omit this local-only choice because the local Desktop path is not visible to a remote Dashboard.

At send time [[src/renderer/src/screens/Chat/Chat.tsx#Chat]] reads synchronous click-intent refs and captures the resolved directory with the message. Frontend-queued messages retain their own promise snapshot; Dashboard `prompt.submit`, session-not-found recovery, backend busy queues, and isolated compute-host frames all forward that same `output_dir`. This prevents a later selection from redirecting an already accepted turn.

The gateway overlay in `scripts/patch-dashboard-output-directory.mjs` validates that `output_dir` is an existing absolute directory, snapshots it in backend queues and isolated compute-host frames, and applies it through the Agent's per-turn ephemeral system prompt. The prior ephemeral prompt is restored in `finally`, so destinations cannot leak across turns or sessions and the visible/persisted user message remains unchanged. The compatibility API path uses an equivalent system message. [[tests/session-output.test.ts]] verifies frontend destination normalization, [[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.test.tsx]] verifies recovery preserves the turn-scoped directory, and [[tests/dashboard-output-directory-overlay.test.ts]] covers backend queue and compute-host propagation.

## Recent folders dropdown

The context folder picker displays recently used project folders first, allowing quick selection across sessions without opening the OS folder dialog.

[[src/renderer/src/screens/Chat/ContextFolderChip.tsx#ContextFolderChip]] presents a dropdown menu populated by [[src/main/session-context-folder-store.ts#getRecentSessionContextFolders]] via the `list-recent-session-context-folders` IPC channel, combining distinct database folder bindings with cached session paths.

## Resizable tree panel

The context-folder tree panel uses a compact header and can be resized from its left edge, mirroring the in-app browser panel.

[[src/renderer/src/screens/Chat/WorktreePanel.tsx#WorktreePanel]] stores its width in `localStorage` under `hermes:worktreePanelWidth`, clamps it between a usable minimum and the available chat width, and updates it through a pointer-drag handle styled by `.worktree-resize-handle`.

## Remote folder picker

Remote and SSH chats use an in-app picker so users do not accidentally select a local macOS folder for a remote session.

[[src/renderer/src/screens/Chat/RemoteFolderPicker.tsx#RemoteFolderPicker]] provides a scrollable folder list, horizontally scrollable breadcrumbs, manual path entry, Escape-to-close, and arrow/Enter keyboard navigation. [[src/main/ipc/register.ts#registerIpcHandlers]] routes `read-directory` to [[src/main/ssh-remote.ts#sshReadDirectory]] for SSH connections and returns no listing for pure Remote Gateway mode until the backend exposes a directory-list endpoint, so the picker still allows typed remote paths.

## Muted tree icons

The tree keeps file-type icon shapes but normalizes their colors so the explorer reads quietly in the chat sidebar.

The `@wesbos/code-icons` SVGs render inside `.worktree-file-icon-wrapper`; CSS overrides inline fills/strokes to `currentColor` while preserving `fill:none` outlines, and folder icons use the same low-opacity white tone.
