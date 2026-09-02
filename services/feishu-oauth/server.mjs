import { createServer } from "node:http";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_REDIRECT_URI =
  "http://183.230.226.81:5082/api/integrations/feishu/oauth/callback";
const AUTHORIZE_URL =
  "https://accounts.feishu.cn/open-apis/authen/v1/authorize";
const TOKEN_URL = "https://open.feishu.cn/open-apis/authen/v2/oauth/token";
const USER_INFO_URL = "https://open.feishu.cn/open-apis/authen/v1/user_info";
const DRIVE_ROOT_URL =
  "https://open.feishu.cn/open-apis/drive/explorer/v2/root_folder/meta";
const DRIVE_FILES_URL = "https://open.feishu.cn/open-apis/drive/v1/files";
const DRIVE_CREATE_FOLDER_URL =
  "https://open.feishu.cn/open-apis/drive/v1/files/create_folder";
const DRIVE_UPLOAD_URL =
  "https://open.feishu.cn/open-apis/drive/v1/files/upload_all";
const OAUTH_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 28 * 1024 * 1024;

export function stateHash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function encryptionKeyFromBase64(value) {
  const key = Buffer.from(String(value || ""), "base64");
  if (key.length !== 32) {
    throw new Error(
      "FEISHU_TOKEN_ENCRYPTION_KEY must be exactly 32 random bytes encoded as base64",
    );
  }
  return key;
}

export function encryptToken(value, key) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptToken(value, key) {
  if (!value) return null;
  const [version, ivValue, tagValue, ciphertextValue] =
    String(value).split(":");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Unsupported encrypted token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivValue, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function authorizationUrl({ appId, redirectUri, state }) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "drive:drive offline_access");
  url.searchParams.set("state", state);
  return url.toString();
}

function requiredEnv(name, env) {
  const value = String(env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function readConfig(env = process.env) {
  const redirectUri = String(
    env.FEISHU_REDIRECT_URI || DEFAULT_REDIRECT_URI,
  ).trim();
  const parsedRedirect = new URL(redirectUri);
  if (
    parsedRedirect.protocol !== "http:" &&
    parsedRedirect.protocol !== "https:"
  ) {
    throw new Error("FEISHU_REDIRECT_URI must use HTTP or HTTPS");
  }
  return {
    appId: requiredEnv("FEISHU_APP_ID", env),
    appSecret: requiredEnv("FEISHU_APP_SECRET", env),
    redirectUri,
    encryptionKey: encryptionKeyFromBase64(
      requiredEnv("FEISHU_TOKEN_ENCRYPTION_KEY", env),
    ),
    host: String(env.FEISHU_OAUTH_HOST || "127.0.0.1"),
    port: Number(env.FEISHU_OAUTH_PORT || 8787),
    databasePath: resolve(
      String(env.FEISHU_OAUTH_DB || "./data/feishu-oauth.sqlite3"),
    ),
  };
}

export function openDatabase(databasePath) {
  if (databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS feishu_oauth_requests (
      request_id TEXT PRIMARY KEY,
      state_hash TEXT NOT NULL UNIQUE,
      employee_user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'connected', 'failed', 'expired')),
      error_message TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      connection_token_encrypted TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_feishu_oauth_expires
      ON feishu_oauth_requests(expires_at);

    CREATE TABLE IF NOT EXISTS feishu_connections (
      employee_user_id TEXT PRIMARY KEY,
      feishu_open_id TEXT,
      feishu_union_id TEXT,
      tenant_key TEXT,
      access_token_encrypted TEXT NOT NULL,
      refresh_token_encrypted TEXT,
      access_expires_at INTEGER NOT NULL,
      refresh_expires_at INTEGER,
      scopes TEXT NOT NULL DEFAULT '',
      connection_token_hash TEXT,
      status TEXT NOT NULL CHECK(status IN ('connected', 'revoked', 'failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const requestColumns = new Set(
    db
      .prepare("PRAGMA table_info(feishu_oauth_requests)")
      .all()
      .map((row) => row.name),
  );
  if (!requestColumns.has("connection_token_encrypted")) {
    db.exec(
      "ALTER TABLE feishu_oauth_requests ADD COLUMN connection_token_encrypted TEXT",
    );
  }
  const connectionColumns = new Set(
    db
      .prepare("PRAGMA table_info(feishu_connections)")
      .all()
      .map((row) => row.name),
  );
  if (!connectionColumns.has("connection_token_hash")) {
    db.exec(
      "ALTER TABLE feishu_connections ADD COLUMN connection_token_hash TEXT",
    );
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_connection_token
      ON feishu_connections(connection_token_hash)
      WHERE connection_token_hash IS NOT NULL;
  `);
  return db;
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function html(res, status, title, message) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:72px 20px"><h2>${escape(title)}</h2><p>${escape(message)}</p></body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function consumeRequest(db, state, now) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT request_id, employee_user_id, expires_at, used_at
         FROM feishu_oauth_requests WHERE state_hash = ?`,
      )
      .get(stateHash(state));
    if (!row || row.used_at || Number(row.expires_at) <= now) {
      db.exec("ROLLBACK");
      return null;
    }
    db.prepare(
      "UPDATE feishu_oauth_requests SET used_at = ? WHERE request_id = ?",
    ).run(now, row.request_id);
    db.exec("COMMIT");
    return row;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function oauthPayload(payload) {
  return payload && typeof payload.data === "object" ? payload.data : payload;
}

async function exchangeAuthorizationCode(config, code, fetchImpl) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  const data = oauthPayload(payload);
  if (!response.ok || !data?.access_token) {
    throw new Error(
      String(
        data?.error_description ||
          data?.error ||
          payload?.msg ||
          "token_exchange_failed",
      ),
    );
  }
  return data;
}

async function fetchUserInfo(accessToken, fetchImpl) {
  const response = await fetchImpl(USER_INFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  const data = oauthPayload(payload);
  if (!response.ok || payload?.code > 0 || !data) {
    throw new Error(String(payload?.msg || "user_info_failed"));
  }
  return data;
}

function markFailed(db, requestId, message) {
  db.prepare(
    `UPDATE feishu_oauth_requests
     SET status = 'failed', error_message = ? WHERE request_id = ?`,
  ).run(String(message || "oauth_failed").slice(0, 500), requestId);
}

function saveConnection(db, config, request, token, user, now) {
  const connectionToken = randomBytes(32).toString("base64url");
  const accessExpiresAt = now + Number(token.expires_in || 7200) * 1000;
  const refreshExpiresAt = token.refresh_token
    ? now + Number(token.refresh_token_expires_in || 604800) * 1000
    : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO feishu_connections (
        employee_user_id, feishu_open_id, feishu_union_id, tenant_key,
        access_token_encrypted, refresh_token_encrypted, access_expires_at,
        refresh_expires_at, scopes, connection_token_hash, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)
      ON CONFLICT(employee_user_id) DO UPDATE SET
        feishu_open_id = excluded.feishu_open_id,
        feishu_union_id = excluded.feishu_union_id,
        tenant_key = excluded.tenant_key,
        access_token_encrypted = excluded.access_token_encrypted,
        refresh_token_encrypted = excluded.refresh_token_encrypted,
        access_expires_at = excluded.access_expires_at,
        refresh_expires_at = excluded.refresh_expires_at,
        scopes = excluded.scopes,
        connection_token_hash = excluded.connection_token_hash,
        status = 'connected',
        updated_at = excluded.updated_at`,
    ).run(
      request.employee_user_id,
      user.open_id || null,
      user.union_id || null,
      user.tenant_key || null,
      encryptToken(token.access_token, config.encryptionKey),
      encryptToken(token.refresh_token, config.encryptionKey),
      accessExpiresAt,
      refreshExpiresAt,
      String(token.scope || ""),
      stateHash(connectionToken),
      now,
      now,
    );
    db.prepare(
      `UPDATE feishu_oauth_requests
       SET status = 'connected', error_message = NULL,
           connection_token_encrypted = ? WHERE request_id = ?`,
    ).run(
      encryptToken(connectionToken, config.encryptionKey),
      request.request_id,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function bearerToken(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(
    String(req.headers.authorization || "").trim(),
  );
  return match?.[1] || "";
}

function connectionForRequest(req, database) {
  const token = bearerToken(req);
  if (!token) return null;
  return database
    .prepare(
      `SELECT employee_user_id FROM feishu_connections
       WHERE connection_token_hash = ? AND status = 'connected'`,
    )
    .get(stateHash(token));
}

async function feishuApiJson(fetchImpl, url, accessToken, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.code || 0) !== 0) {
    const error = new Error(
      String(payload?.msg || "feishu_drive_request_failed"),
    );
    error.statusCode = response.status === 401 ? 401 : 502;
    throw error;
  }
  return payload?.data && typeof payload.data === "object" ? payload.data : {};
}

function safeName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error("invalid_file_name");
  }
  return name;
}

async function driveRequestContext(req, database, config, fetchImpl, now) {
  const connection = connectionForRequest(req, database);
  if (!connection) return null;
  const accessToken = await getValidAccessToken({
    employeeUserId: connection.employee_user_id,
    config,
    database,
    fetchImpl,
    now,
  });
  return { accessToken };
}

export function createFeishuOAuthService({
  config = readConfig(),
  database = openDatabase(config.databasePath),
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/health") {
        return json(res, 200, { ok: true });
      }

      if (
        req.method === "POST" &&
        path === "/api/integrations/feishu/oauth/start"
      ) {
        const body = await readJson(req);
        const employeeUserId = String(body.employee_user_id || "").trim();
        if (!employeeUserId || employeeUserId.length > 128) {
          return json(res, 400, { error: "invalid_employee_user_id" });
        }
        const requestId = randomBytes(24).toString("base64url");
        const state = randomBytes(32).toString("base64url");
        const createdAt = now();
        database
          .prepare(
            `INSERT INTO feishu_oauth_requests
             (request_id, state_hash, employee_user_id, status, created_at, expires_at)
             VALUES (?, ?, ?, 'pending', ?, ?)`,
          )
          .run(
            requestId,
            stateHash(state),
            employeeUserId,
            createdAt,
            createdAt + OAUTH_TTL_MS,
          );
        return json(res, 200, {
          request_id: requestId,
          authorization_url: authorizationUrl({
            appId: config.appId,
            redirectUri: config.redirectUri,
            state,
          }),
          expires_in: OAUTH_TTL_MS / 1000,
        });
      }

      if (
        req.method === "GET" &&
        path === "/api/integrations/feishu/oauth/status"
      ) {
        const requestId = String(url.searchParams.get("request_id") || "");
        const row = database
          .prepare(
            `SELECT status, error_message, expires_at, connection_token_encrypted
             FROM feishu_oauth_requests WHERE request_id = ?`,
          )
          .get(requestId);
        if (!row) return json(res, 404, { error: "request_not_found" });
        let status = row.status;
        if (status === "pending" && Number(row.expires_at) <= now()) {
          status = "expired";
          database
            .prepare(
              "UPDATE feishu_oauth_requests SET status = 'expired' WHERE request_id = ?",
            )
            .run(requestId);
        }
        return json(res, 200, {
          status,
          ...(row.error_message ? { error: row.error_message } : {}),
          ...(status === "connected" &&
          Number(row.expires_at) > now() &&
          row.connection_token_encrypted
            ? {
                connection_token: decryptToken(
                  row.connection_token_encrypted,
                  config.encryptionKey,
                ),
              }
            : {}),
        });
      }

      if (path.startsWith("/api/integrations/feishu/drive/")) {
        const drive = await driveRequestContext(
          req,
          database,
          config,
          fetchImpl,
          now,
        );
        if (!drive) {
          return json(res, 401, { error: "invalid_connection_token" });
        }

        if (
          req.method === "GET" &&
          path === "/api/integrations/feishu/drive/root"
        ) {
          const data = await feishuApiJson(
            fetchImpl,
            DRIVE_ROOT_URL,
            drive.accessToken,
          );
          return json(res, 200, data);
        }

        if (
          req.method === "GET" &&
          path === "/api/integrations/feishu/drive/files"
        ) {
          const upstream = new URL(DRIVE_FILES_URL);
          for (const key of ["folder_token", "page_token", "page_size"]) {
            const value = url.searchParams.get(key);
            if (value) upstream.searchParams.set(key, value);
          }
          const data = await feishuApiJson(
            fetchImpl,
            upstream,
            drive.accessToken,
          );
          return json(res, 200, data);
        }

        if (
          req.method === "POST" &&
          path === "/api/integrations/feishu/drive/folders"
        ) {
          const body = await readJson(req);
          const name = safeName(body.name);
          const folderToken = String(body.folder_token || "").trim();
          if (!folderToken) {
            return json(res, 400, { error: "folder_token_required" });
          }
          const data = await feishuApiJson(
            fetchImpl,
            DRIVE_CREATE_FOLDER_URL,
            drive.accessToken,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, folder_token: folderToken }),
            },
          );
          return json(res, 200, data);
        }

        if (
          req.method === "POST" &&
          path === "/api/integrations/feishu/drive/files/upload"
        ) {
          const body = await readJson(req, MAX_UPLOAD_BODY_BYTES);
          const fileName = safeName(body.file_name);
          const parentNode = String(body.parent_node || "").trim();
          const encoded = String(body.content_base64 || "");
          if (!parentNode) {
            return json(res, 400, { error: "parent_node_required" });
          }
          const content = Buffer.from(encoded, "base64");
          if (!encoded || content.length > MAX_UPLOAD_BYTES) {
            return json(res, 400, { error: "invalid_upload_size" });
          }
          const form = new FormData();
          form.set("file_name", fileName);
          form.set("parent_type", "explorer");
          form.set("parent_node", parentNode);
          form.set("size", String(content.length));
          form.set("file", new Blob([content]), fileName);
          const data = await feishuApiJson(
            fetchImpl,
            DRIVE_UPLOAD_URL,
            drive.accessToken,
            { method: "POST", body: form },
          );
          return json(res, 200, data);
        }

        const deleteMatch =
          req.method === "DELETE"
            ? /^\/api\/integrations\/feishu\/drive\/files\/([^/]+)$/.exec(path)
            : null;
        if (deleteMatch) {
          const fileType = String(
            url.searchParams.get("type") || "file",
          ).trim();
          if (fileType === "folder") {
            return json(res, 400, { error: "folder_deletion_not_supported" });
          }
          const upstream = new URL(
            `${DRIVE_FILES_URL}/${encodeURIComponent(
              decodeURIComponent(deleteMatch[1]),
            )}`,
          );
          upstream.searchParams.set("type", fileType);
          const data = await feishuApiJson(
            fetchImpl,
            upstream,
            drive.accessToken,
            { method: "DELETE" },
          );
          return json(res, 200, data);
        }

        return json(res, 404, { error: "not_found" });
      }

      if (
        req.method === "GET" &&
        path === new URL(config.redirectUri).pathname
      ) {
        const state = String(url.searchParams.get("state") || "");
        if (!state) {
          return html(
            res,
            400,
            "飞书授权失败",
            "回调缺少 state，请返回数字员工重试。",
          );
        }
        const request = consumeRequest(database, state, now());
        if (!request) {
          return html(
            res,
            400,
            "飞书授权失败",
            "授权请求无效、已使用或已经过期。",
          );
        }
        const providerError = url.searchParams.get("error");
        if (providerError) {
          markFailed(database, request.request_id, providerError);
          return html(
            res,
            400,
            "飞书授权已取消",
            "可以关闭此页面并返回数字员工。",
          );
        }
        const code = String(url.searchParams.get("code") || "");
        if (!code) {
          markFailed(database, request.request_id, "missing_code");
          return html(
            res,
            400,
            "飞书授权失败",
            "回调缺少授权码，请返回数字员工重试。",
          );
        }
        try {
          const token = await exchangeAuthorizationCode(
            config,
            code,
            fetchImpl,
          );
          const user = await fetchUserInfo(token.access_token, fetchImpl);
          saveConnection(database, config, request, token, user, now());
          return html(
            res,
            200,
            "飞书连接成功",
            "现在可以关闭此页面并返回数字员工。",
          );
        } catch (error) {
          markFailed(
            database,
            request.request_id,
            error instanceof Error ? error.message : error,
          );
          return html(
            res,
            502,
            "飞书授权失败",
            "服务器未能完成授权，请返回数字员工重试。",
          );
        }
      }

      return json(res, 404, { error: "not_found" });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : "";
      const message =
        error instanceof SyntaxError
          ? "invalid_json"
          : rawMessage === "request_body_too_large" ||
              rawMessage === "invalid_file_name"
            ? rawMessage
            : rawMessage === "feishu_not_connected" ||
                rawMessage === "feishu_reauthorization_required"
              ? "feishu_reauthorization_required"
              : "internal_error";
      const status =
        Number(error?.statusCode) ||
        (message === "invalid_json" ||
        message === "request_body_too_large" ||
        message === "invalid_file_name"
          ? 400
          : message === "feishu_reauthorization_required"
            ? 401
            : 500);
      console.error("[feishu-oauth] request failed", rawMessage || error);
      return json(res, status, { error: message });
    }
  }

  return { handler, database, config };
}

export async function getValidAccessToken({
  employeeUserId,
  config,
  database,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const row = database
    .prepare(
      "SELECT * FROM feishu_connections WHERE employee_user_id = ? AND status = 'connected'",
    )
    .get(employeeUserId);
  if (!row) throw new Error("feishu_not_connected");
  if (Number(row.access_expires_at) > now() + TOKEN_REFRESH_SKEW_MS) {
    return decryptToken(row.access_token_encrypted, config.encryptionKey);
  }
  const refreshToken = decryptToken(
    row.refresh_token_encrypted,
    config.encryptionKey,
  );
  if (!refreshToken || Number(row.refresh_expires_at || 0) <= now()) {
    throw new Error("feishu_reauthorization_required");
  }
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.appId,
      client_secret: config.appSecret,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json();
  const token = oauthPayload(payload);
  if (!response.ok || !token?.access_token) {
    database
      .prepare(
        "UPDATE feishu_connections SET status = 'failed', updated_at = ? WHERE employee_user_id = ?",
      )
      .run(now(), employeeUserId);
    throw new Error("feishu_reauthorization_required");
  }
  const refreshedAt = now();
  const nextRefreshToken = token.refresh_token || refreshToken;
  database
    .prepare(
      `UPDATE feishu_connections SET
      access_token_encrypted = ?, refresh_token_encrypted = ?,
      access_expires_at = ?, refresh_expires_at = ?, scopes = ?, updated_at = ?
     WHERE employee_user_id = ?`,
    )
    .run(
      encryptToken(token.access_token, config.encryptionKey),
      encryptToken(nextRefreshToken, config.encryptionKey),
      refreshedAt + Number(token.expires_in || 7200) * 1000,
      refreshedAt + Number(token.refresh_token_expires_in || 604800) * 1000,
      String(token.scope || row.scopes || ""),
      refreshedAt,
      employeeUserId,
    );
  return token.access_token;
}

export function startServer(env = process.env) {
  const config = readConfig(env);
  const service = createFeishuOAuthService({ config });
  const server = createServer(service.handler);
  server.listen(config.port, config.host, () => {
    console.log(
      `[feishu-oauth] listening on http://${config.host}:${config.port}`,
    );
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  startServer();
}
