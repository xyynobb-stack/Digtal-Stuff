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
  config?: { context_limit?: unknown };
}

export interface EmployeeChatModel {
  model: string;
  name: string;
  contextLength?: number;
  apiMode: "chat_completions" | "codex_responses";
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
] as const;

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
 * Import supported conversational protocols, not just Chat Completions.
 * Compact-only is not a conversation endpoint. Prefer chat when both exist.
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
    const apiMode = formats.includes("openai:chat")
      ? "chat_completions"
      : formats.includes("openai:responses")
        ? "codex_responses"
        : null;
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
