# User-authorized Feishu Drive

Each employee operates files in their own Feishu Drive after connecting their Feishu account; the desktop no longer creates or exposes an application-owned shared area.

## Connection boundary

The profile stores a random JingYuAI connection token, while the Feishu app secret and user access and refresh tokens remain only on the OAuth server.

[[src/main/ipc/register.ts#registerIpcHandlers]] saves `FEISHU_OAUTH_CONNECTION_TOKEN` and the service URL only after the OAuth request is bound to the same employee profile. [[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_service_config]] gates all file tools on that connection token, so an unconnected profile cannot expose the tools.

The connection token is hashed in the server database. Its plaintext is returned once through the short-lived OAuth status request and is never accepted as a model-visible tool argument.

## Personal Drive operations

The server converts authenticated JingYuAI requests into Feishu Drive API calls made with the connected employee's current `user_access_token`.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_list_files]] lists the user root or a selected folder. [[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_search_files]] recursively searches names with pagination and traversal limits. Folder creation, file upload, and file deletion target tokens in the same user's Drive authorization context.

There is no initialization tool, managed root, application-owned shared folder, or desktop-side App ID and App Secret path.

## Local upload safety

Uploads read an existing task-accessible local file, reject protected credential paths, and limit complete uploads to 20 MiB before sending base64 data to the server proxy.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_resolve_upload_path]] reuses the Agent's path resolution and read-deny policy. The server decodes the content and submits multipart form data to Feishu without disclosing the Feishu user token to the desktop.

## Destructive operation guard

Single-file deletion requires the exact confirmation string `DELETE:<file_token>` and folder deletion is deliberately unsupported.

[[build/offline-runtime/hermes-agent/tools/feishu_drive_files_tool.py#_handle_delete_file]] enforces both checks before contacting the server, while the server independently rejects a folder type.

## Runtime delivery

Development and packaged Agents receive the same canonical OAuth-proxy implementation and expose the same five file tools to desktop chat, scheduled tasks, CLI, and ACP sessions.

`scripts/apply-offline-runtime-overlays.mjs#patchFeishuDriveToolsetSource` removes the obsolete initialization tool, assigns the five OAuth actions to the dedicated `feishu_user_drive` toolset, adds them to the API-server and ACP composites, and adds them to the shared core inherited by CLI and cron. Keeping this toolset separate from legacy app-credential comment actions lets platform resolution expose it in direct desktop conversations. `scripts/prepare-dev-agent.mjs#syncDevFeishuDriveTools` copies the canonical overlay into an installed development Agent.

### Built-in discovery

The five file actions use top-level `registry.register(...)` calls so Hermes' AST-based built-in scanner recognizes and imports the module automatically from the system `tools/` directory; the model never needs Tool Search to discover them.

## Verification

Tests mock the service boundary and Feishu upstream so no real credentials or user files are touched.

[[tests/test_feishu_drive_files_tool.py#UserAuthorizedFeishuDriveTests]] covers connection gating, root listing, folder creation, upload transport, deletion guards, and recursive search. `services/feishu-oauth/server.test.mjs` covers connection-token hashing and authenticated Drive proxy requests made with the stored user token.
