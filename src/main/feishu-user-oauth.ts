import { shell } from "electron";

const DEFAULT_FEISHU_OAUTH_BASE_URL = "http://183.230.226.81:5082";

export interface FeishuOAuthStartResult {
  requestId: string;
  expiresIn: number;
}

export interface FeishuOAuthStatusResult {
  status: "pending" | "connected" | "failed" | "expired";
  error?: string;
  connectionToken?: string;
}

function serviceBaseUrl(): URL {
  const value = String(
    process.env.FEISHU_OAUTH_BASE_URL || DEFAULT_FEISHU_OAUTH_BASE_URL,
  ).trim();
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("飞书授权服务地址必须使用 HTTP 或 HTTPS。");
  }
  return parsed;
}

export function feishuOAuthServiceBaseUrl(): string {
  return serviceBaseUrl().toString().replace(/\/$/, "");
}

async function responseJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? `飞书授权服务返回错误：${payload.error}`
        : `飞书授权服务不可用（HTTP ${response.status}）。`,
    );
  }
  return payload;
}

export async function startFeishuUserOAuth(
  employeeUserId: string,
): Promise<FeishuOAuthStartResult> {
  const serviceUrl = new URL(
    "/api/integrations/feishu/oauth/start",
    serviceBaseUrl(),
  );
  const response = await fetch(serviceUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ employee_user_id: employeeUserId }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await responseJson(response);
  const requestId =
    typeof payload.request_id === "string" ? payload.request_id : "";
  const authorizationUrl =
    typeof payload.authorization_url === "string"
      ? payload.authorization_url
      : "";
  const expiresIn = Number(payload.expires_in || 600);
  const parsedAuthorizationUrl = new URL(authorizationUrl);
  if (
    !requestId ||
    parsedAuthorizationUrl.protocol !== "https:" ||
    parsedAuthorizationUrl.hostname !== "accounts.feishu.cn"
  ) {
    throw new Error("飞书授权服务返回了无效的授权地址。");
  }
  await shell.openExternal(parsedAuthorizationUrl.toString());
  return { requestId, expiresIn };
}

export async function getFeishuUserOAuthStatus(
  requestId: string,
): Promise<FeishuOAuthStatusResult> {
  const serviceUrl = new URL(
    "/api/integrations/feishu/oauth/status",
    serviceBaseUrl(),
  );
  serviceUrl.searchParams.set("request_id", requestId);
  const response = await fetch(serviceUrl, {
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await responseJson(response);
  const status = payload.status;
  if (
    status !== "pending" &&
    status !== "connected" &&
    status !== "failed" &&
    status !== "expired"
  ) {
    throw new Error("飞书授权服务返回了未知状态。");
  }
  return {
    status,
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    ...(typeof payload.connection_token === "string"
      ? { connectionToken: payload.connection_token }
      : {}),
  };
}
