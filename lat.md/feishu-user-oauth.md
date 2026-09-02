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

## Deployment boundary

The configured HTTP callback is routed by a host-networked Caddy container to a loopback-only Node service, while secrets and the token-encryption key live in a server environment file outside the repository.

The checked-in examples under `services/feishu-oauth/` define the Node runtime, HTTP proxy, systemd unit, and environment variable contract. The current NAT path maps public `183.230.226.81:5082` to the server's original port `5000`. HTTP is an explicitly accepted deployment risk for this internal stage because callback and status traffic lacks transport encryption; broader release should migrate to trusted HTTPS.

## Drive proxy

Authenticated Drive routes expose the minimum operations needed by the desktop tool: root lookup, folder listing, folder creation, complete file upload, and file deletion.

Every route resolves the connection token to one employee connection and calls Feishu with that employee's refreshed `user_access_token`. The desktop-facing behavior is documented in [[feishu-drive]]; the obsolete application-owned shared-area flow is not registered.

## Verification

The service tests cover encryption, authorization parameters, state hashing, database migration, a complete mocked start-callback-status exchange, and authenticated Drive proxy operations.

`services/feishu-oauth/server.test.mjs` verifies that the callback binds the Feishu identity to the initiating employee, persists encrypted token material, hashes the desktop connection token, and uses the user token for Drive calls.
