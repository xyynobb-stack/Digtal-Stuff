import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { profileHome, safeWriteFile } from "./utils";
import type { SavedModel } from "./models";

function employeeModelAccessFile(profile?: string): string {
  return join(profileHome(profile), "employee-model-access.json");
}

export interface EmployeeAvailableModelPayload {
  name?: unknown;
  display_name?: unknown;
  api_formats?: unknown;
  preferred_api_format?: unknown;
  config?: { context_limit?: unknown };
}

export type EmployeeModelApiMode =
  | "chat_completions"
  | "codex_responses"
  | "anthropic_messages";

export interface EmployeeChatModel {
  model: string;
  name: string;
  contextLength?: number;
  apiMode: EmployeeModelApiMode;
}

// Separate named routes share credentials, never a mutable protocol setting.
export const EMPLOYEE_MODEL_ROUTES = [
  {
    apiMode: "chat_completions",
    slug: "company-platform",
    name: "Company Platform",
  },
  {
    apiMode: "codex_responses",
    slug: "company-platform-responses",
    name: "Company Platform Responses",
  },
  {
    apiMode: "anthropic_messages",
    slug: "company-platform-anthropic",
    name: "Company Platform Anthropic",
  },
] as const;

type EmployeeApiFormat = "openai:chat" | "openai:responses" | "claude:messages";

const API_MODE_BY_FORMAT: Record<EmployeeApiFormat, EmployeeModelApiMode> = {
  "openai:chat": "chat_completions",
  "openai:responses": "codex_responses",
  "claude:messages": "anthropic_messages",
};

function isEmployeeApiFormat(value: unknown): value is EmployeeApiFormat {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(API_MODE_BY_FORMAT, value)
  );
}

function knownModelPreferredFormat(model: string): EmployeeApiFormat | null {
  const normalized = model.toLowerCase();
  if (normalized.startsWith("claude-")) return "claude:messages";
  if (normalized.startsWith("gpt-5.6-")) return "openai:responses";
  if (
    normalized.startsWith("deepseek-") ||
    normalized.startsWith("qwen") ||
    normalized.startsWith("grok-")
  ) {
    return "openai:chat";
  }
  return null;
}

function resolveEmployeeApiFormat(
  model: string,
  rawFormats: unknown[],
  rawPreferred: unknown,
): EmployeeApiFormat | null {
  const formats = new Set(rawFormats.filter(isEmployeeApiFormat));

  // Claude must use its native wire protocol even if the catalog also
  // advertises compatibility shims that the upstream route cannot execute.
  const knownPreferred = knownModelPreferredFormat(model);
  if (knownPreferred === "claude:messages") {
    return formats.has(knownPreferred) ? knownPreferred : null;
  }

  if (isEmployeeApiFormat(rawPreferred) && formats.has(rawPreferred)) {
    return rawPreferred;
  }

  if (knownPreferred && formats.has(knownPreferred)) return knownPreferred;

  // Backward compatibility for older catalogs without preferred_api_format.
  if (formats.has("openai:chat")) return "openai:chat";
  if (formats.has("openai:responses")) return "openai:responses";
  if (formats.has("claude:messages")) return "claude:messages";
  return null;
}

export interface EmployeeModelAccess {
  provider: string;
  baseUrl: string;
  models: string[];
  updatedAt: number;
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Import supported conversational protocols and bind each model to one stable
 * route. Prefer the catalog's valid preferred_api_format, with tested family
 * defaults for catalogs that have not published that field yet.
 */
export function normalizeEmployeeChatModels(
  entries: EmployeeAvailableModelPayload[] | undefined,
): EmployeeChatModel[] {
  const result: EmployeeChatModel[] = [];
  const seen = new Set<string>();

  for (const entry of entries || []) {
    const model = typeof entry.name === "string" ? entry.name.trim() : "";
    const formats = Array.isArray(entry.api_formats)
      ? entry.api_formats
      : [entry.api_formats];
    const apiFormat = resolveEmployeeApiFormat(
      model,
      formats,
      entry.preferred_api_format,
    );
    const apiMode = apiFormat ? API_MODE_BY_FORMAT[apiFormat] : null;
    if (!model || !apiMode || seen.has(model)) {
      continue;
    }

    const displayName =
      typeof entry.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : model;
    const rawContextLength = entry.config?.context_limit;
    const contextLength =
      typeof rawContextLength === "number" &&
      Number.isFinite(rawContextLength) &&
      rawContextLength > 0
        ? Math.floor(rawContextLength)
        : undefined;

    seen.add(model);
    result.push({
      model,
      name: displayName,
      apiMode,
      ...(contextLength ? { contextLength } : {}),
    });
  }

  return result;
}

export function readEmployeeModelAccess(
  profile?: string,
): EmployeeModelAccess | null {
  try {
    const file = employeeModelAccessFile(profile);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(
      readFileSync(file, "utf-8"),
    ) as Partial<EmployeeModelAccess>;
    if (
      typeof parsed.provider !== "string" ||
      typeof parsed.baseUrl !== "string" ||
      !Array.isArray(parsed.models)
    ) {
      return null;
    }
    const models = Array.from(
      new Set(
        parsed.models.filter(
          (model): model is string =>
            typeof model === "string" && model.trim().length > 0,
        ),
      ),
    );
    if (models.length === 0) return null;
    return {
      provider: parsed.provider,
      baseUrl: parsed.baseUrl,
      models,
      updatedAt:
        typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeEmployeeModelAccess(
  provider: string,
  baseUrl: string,
  models: string[],
  profile?: string,
): EmployeeModelAccess {
  const access: EmployeeModelAccess = {
    provider,
    baseUrl,
    models: Array.from(new Set(models.map((model) => model.trim()))).filter(
      Boolean,
    ),
    updatedAt: Date.now(),
  };
  if (access.models.length === 0) {
    throw new Error("Employee model access cannot be empty.");
  }
  safeWriteFile(
    employeeModelAccessFile(profile),
    JSON.stringify(access, null, 2),
  );
  return access;
}

/** Restrict the renderer-facing local model catalog to the employee grant. */
export function filterModelsForEmployeeAccess(
  models: SavedModel[],
  access: EmployeeModelAccess | null = readEmployeeModelAccess(),
): SavedModel[] {
  if (!access) return models;
  const allowed = new Set(access.models);
  const accessBaseUrl = normalizeBaseUrl(access.baseUrl);
  return models.filter(
    (model) =>
      model.provider === access.provider &&
      normalizeBaseUrl(model.baseUrl) === accessBaseUrl &&
      allowed.has(model.model),
  );
}
