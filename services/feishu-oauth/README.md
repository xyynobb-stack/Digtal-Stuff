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

### 新版在线文档接口

以下接口均沿用上述连接凭据；`:document_id` 是 `/docx/` 链接中的 ID。

- `GET /api/integrations/feishu/drive/documents/:document_id/content?offset=0&limit=12000`：正文分页，返回 `content`、`total_chars`、`next_offset`。
- `GET /api/integrations/feishu/drive/documents/:document_id/blocks?page_token=...`：每页 50 个文档块，返回 `items`、`has_more` 和 `page_token`。
- `POST /api/integrations/feishu/drive/documents/:document_id/append`，正文 `{ "text": "追加段落" }`。
- `PATCH /api/integrations/feishu/drive/documents/:document_id/blocks/:block_id`，正文 `{ "expected_text": "完整旧段落", "text": "新段落" }`。先读后写，旧文本不一致返回 409；使用同一文档版本提交，不做无条件覆盖。

写入每次最多 2000 字符，不解析 Markdown。仅编辑普通文本/标题块，保留其他段落；富文本、表格、附件、知识库链接和整篇替换不在此版本范围。写入超时后应先读取结果，不盲目重试。权限失败保留 `upstream_code`，不要仅凭通用错误认定授权过期。

接口依据飞书 [获取文档块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/list)、[创建块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/create)、[更新块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document-block/patch) 定义，使用直接 HTTP 请求，不安装 `lark-oapi`。

### 升级已有部署以启用文档读写

1. 飞书开放平台开通用户身份 `docx:document`，保留 `drive:drive`、`offline_access`，发布/审批新权限。
2. 将本目录最新 `server.mjs` 替换到服务器原服务目录。保留原 `.env`、数据库和加密密钥，不需要重新初始化。
3. 执行 `systemctl --user restart feishu-oauth`，确认 `/health` 返回正常。
4. 开发版停止后执行 `npm.cmd run dev`（其 predev 自动同步工具），安装版需安装包含本次代码的新构建。
5. 在对应员工 Profile 中重新“连接飞书”，让授权包含新 scope；创建新对话测试读取、追加和修改指定段落。

已有授权不会因后台勾选权限就自动获得新增 scope。桌面发布也不会自动更新这台独立 OAuth 服务器。

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
