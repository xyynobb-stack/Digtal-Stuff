# Feishu user OAuth service

This service implements the public OAuth callback for employees who connect their own Feishu Drive to JingYuAI. App credentials stay on the server; per-user access and refresh tokens are encrypted with AES-256-GCM in SQLite.

## Endpoints

- `POST /api/integrations/feishu/oauth/start` with `{ "employee_user_id": "..." }`
- `GET /api/integrations/feishu/oauth/callback?code=...&state=...`
- `GET /api/integrations/feishu/oauth/status?request_id=...`
- `GET /api/integrations/feishu/drive/root`
- `GET /api/integrations/feishu/drive/files?folder_token=...`
- `POST /api/integrations/feishu/drive/folders`
- `POST /api/integrations/feishu/drive/files/upload`
- `DELETE /api/integrations/feishu/drive/files/:file_token?type=...`
- `GET /health`

Drive routes require `Authorization: Bearer <connection_token>`. This is a JingYuAI connection credential, not a Feishu access token. The desktop obtains it from the successful, still-valid OAuth status request and stores it in the employee profile; Feishu tokens never leave the server.

The configured callback is `http://183.230.226.81:5082/api/integrations/feishu/oauth/callback`. The value used during code exchange must exactly match the redirect URI configured in the Feishu developer console.

## Server setup

1. Install Node.js 24 or newer on the server.
2. Copy this directory to `/home/admin1/digital_stuff/opt/jingyuai/feishu-oauth`.
3. Create `.env` in that directory from `.env.example`. Put the existing App ID and App Secret there; do not copy them into the desktop package or source repository.
4. Generate the encryption key with `openssl rand -base64 32` and keep it outside the database and backups that contain the database.
5. Install the user-level systemd unit and start the HTTP reverse proxy from `docker-compose.http.yml`.
6. Start the service and verify `/health` before testing the Feishu authorization flow.

To start the proxy, copy `Caddyfile.http.example` to `Caddyfile.http` and run `sudo docker compose -f docker-compose.http.yml up -d`. Caddy listens on the server's original port `5000`, which the current NAT allocation exposes as public port `5082`, and uses host networking so its loopback upstream reaches the Node service without exposing port 8787.

This HTTP deployment sends the OAuth callback code and status traffic without transport encryption. It is suitable only for the explicitly accepted internal rollout risk; migrate to a DNS hostname with trusted HTTPS before exposing the integration more broadly.

## Security boundary

The current start endpoint accepts the stable employee user ID supplied by the desktop flow. Before broad internal rollout, place it behind the existing employee provisioning session or require a short-lived signed connection ticket issued after successful phone provisioning. The OAuth `state` is random, stored only as a hash, expires after ten minutes, and is consumed once.

The service never returns Feishu tokens to the desktop. Drive operation endpoints obtain a current user token through `getValidAccessToken`; the connection token kept by the desktop is stored only as a SHA-256 hash on the server and rotates when that employee reconnects.

After deploying a server version that adds connection tokens, employees whose OAuth connection predates that version must click “连接飞书” again once. Restart the user service with `systemctl --user restart feishu-oauth` after replacing `server.mjs`, then verify both `/health` and the desktop authorization flow.
