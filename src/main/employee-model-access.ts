import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { HERMES_HOME } from "./installer";
import { safeWriteFile } from "./utils";
import type { SavedModel } from "./models";

const EMPLOYEE_MODEL_ACCESS_FILE = join(
  HERMES_HOME,
  "employee-model-access.json",
);

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
 * Keep only models the employee endpoint explicitly marks as OpenAI chat
 * compatible. Duplicate model ids are collapsed while preserving API order.
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
    if (!model || !formats.includes("openai:chat") || seen.has(model)) {
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
      ...(contextLength ? { contextLength } : {}),
    });
  }

  return result;
}

export function readEmployeeModelAccess(): EmployeeModelAccess | null {
  try {
    if (!existsSync(EMPLOYEE_MODEL_ACCESS_FILE)) return null;
    const parsed = JSON.parse(
      readFileSync(EMPLOYEE_MODEL_ACCESS_FILE, "utf-8"),
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
  safeWriteFile(EMPLOYEE_MODEL_ACCESS_FILE, JSON.stringify(access, null, 2));
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
