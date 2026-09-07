# Feishu User OAuth

Employees connect their own Feishu accounts through a server-owned OAuth flow so desktop packages never contain the app secret or reusable Feishu user tokens.

## Server authorization boundary

The public callback, one-time OAuth state, encrypted token store, and refresh lifecycle run in a standalone server process rather than Electron.

`services/feishu-oauth/server.mjs` exposes start, callback, status, and health routes. OAuth state expires after ten minutes, is stored only as a hash, and is atomically consumed once. User access and refresh tokens are encrypted with AES-256-GCM before SQLite persistence.

Its `getValidAccessToken` function returns a current server-side user token for Drive proxy operations and refreshes it before expiry. Feishu tokens are never returned by the public status endpoint.

After a successful callback, the service creates a separate random connection token, stores only its hash with the Feishu connection, and returns its plaintext through the initiating OAuth status request while that request remains valid.

## Desktop connection flow

The desktop opens only a validated Feishu authorization URL and observes connection state through narrow main-process IPC methods.

[[src/main/feishu-user-oauth.ts#startFeishuUserOAuth]] starts authorization with the stable employee user ID and delegates the browser launch to Electron. [[src/renderer/src/screens/Providers/Providers.tsx#Providers]] shows the connection action after phone provisioning and polls the opaque request ID until success, failure, or expiry.

The main process verifies the target profile's employee binding before saving the returned connection token in that profile's secret environment. The renderer receives only connection status, never the credential.

Dashboard Agents snapshot their available tools when a session is constructed. After a successful authorization, the main process restarts only the target Profile's already-running local Dashboard after saving credentials; the renderer remains loaded and resumes its durable sessions against the replacement process, preserving tabs and history while rebuilding tool snapshots. An unopened Dashboard is left stopped, and remote Dashboards are not controlled by the local desktop.

## Deployment boundary

The configured HTTP callback is routed by a host-networked Caddy container to a loopback-only Node service, while secrets and the token-encryption key live in a server environment file outside the repository.

The checked-in examples under `services/feishu-oauth/` define the Node runtime, HTTP proxy, systemd unit, and environment variable contract. The current NAT path maps public `183.230.226.81:5082` to the server's original port `5000`. HTTP is an explicitly accepted deployment risk for this internal stage because callback and status traffic lacks transport encryption; broader release should migrate to trusted HTTPS.

## Drive proxy

Authenticated Drive routes expose root lookup, shared document search, folder operations, file upload and deletion, ordinary attachment download, native document editing, and spreadsheet range operations.

新增文档接口位于 `/api/integrations/feishu/drive/documents/:document_id/` 下，包含 `content`、`blocks`、`append` 和 `blocks/:block_id`。普通附件下载限制为 20 MiB。共享搜索会根据连接记录中的 `feishu_open_id` 标注当前用户所有权。表格接口位于 `/spreadsheets/:spreadsheet_token/`；嵌入式多维表格通过 `/bitables/:app_token/tables/:table_id/fields`、`records` 和 `records/:record_id` 读取字段与记录并更新单条记录。所有接口使用员工用户令牌；OAuth scope 包含 Drive、Docx、Sheets、Bitable 与离线访问权限，已有员工在新增权限后需重新连接授权。

上游 401、403 及飞书缺少权限码会分别返回稳定的重新授权或权限不足错误，并保留数值 `upstream_code`；其他飞书 API 失败返回 `feishu_api_error`。原始上游消息与令牌不会返回客户端，因此权限问题不再被统一折叠为 `internal_error`。

Every route resolves the connection token to one employee connection and calls Feishu with that employee's refreshed `user_access_token`. The desktop-facing behavior is documented in [[feishu-drive]]; the obsolete application-owned shared-area flow is not registered.

## Verification

The service tests cover encryption, authorization parameters, state hashing, database migration, a complete mocked start-callback-status exchange, and authenticated Drive proxy operations.

文档回归测试覆盖两个员工的令牌隔离、无凭据拒绝、正文及块分页、追加、旧文本冲突、富文本拒绝、版本绑定和权限错误脱敏；工具测试直接加载 canonical overlay，打包测试覆盖五工具快照升级及重复执行的幂等性。

`services/feishu-oauth/server.test.mjs` verifies that the callback binds the Feishu identity to the initiating employee, persists encrypted token material, hashes the desktop connection token, and uses the user token for Drive calls.
