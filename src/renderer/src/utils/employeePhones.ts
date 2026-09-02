const EMPLOYEE_PHONES_STORAGE_KEY = "hermes.configuredEmployeePhones";
const EMPLOYEE_CONFIGURATIONS_STORAGE_KEY = "hermes.configuredEmployees";

export interface ConfiguredEmployee {
  phone: string;
  realName: string;
  models: string[];
  profileId?: string;
  roleName?: string;
  roleStatus?: "awaiting_position" | "configured" | "unmapped";
}

export function normalizeEmployeePhone(phone: string): string {
  return phone.replace(/\s|-/g, "");
}

export function loadConfiguredEmployeePhones(): string[] {
  try {
    const raw = window.localStorage.getItem(EMPLOYEE_PHONES_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(
        parsed.filter(
          (value): value is string =>
            typeof value === "string" && /^1\d{10}$/.test(value),
        ),
      ),
    );
  } catch {
    return [];
  }
}

export function rememberConfiguredEmployeePhone(phone: string): string[] {
  const normalized = normalizeEmployeePhone(phone);
  const next = /^1\d{10}$/.test(normalized) ? [normalized] : [];
  try {
    window.localStorage.setItem(
      EMPLOYEE_PHONES_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Return the deduplicated in-memory list when storage is unavailable.
  }
  return next;
}

export function loadConfiguredEmployees(): ConfiguredEmployee[] {
  let configured: ConfiguredEmployee[] = [];
  try {
    const raw = window.localStorage.getItem(
      EMPLOYEE_CONFIGURATIONS_STORAGE_KEY,
    );
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      configured = parsed.flatMap((value): ConfiguredEmployee[] => {
        if (!value || typeof value !== "object") return [];
        const candidate = value as Partial<ConfiguredEmployee> & {
          username?: unknown;
        };
        const phone =
          typeof candidate.phone === "string"
            ? normalizeEmployeePhone(candidate.phone)
            : "";
        if (!/^1\d{10}$/.test(phone)) return [];
        const realName =
          typeof candidate.realName === "string"
            ? candidate.realName.trim()
            : typeof candidate.username === "string"
              ? candidate.username.trim()
              : "";
        const models = Array.isArray(candidate.models)
          ? Array.from(
              new Set(
                candidate.models.filter(
                  (model): model is string =>
                    typeof model === "string" && model.trim().length > 0,
                ),
              ),
            )
          : [];
        const profileId =
          typeof candidate.profileId === "string"
            ? candidate.profileId.trim()
            : "";
        const roleName =
          typeof candidate.roleName === "string"
            ? candidate.roleName.trim()
            : "";
        const roleStatus = [
          "awaiting_position",
          "configured",
          "unmapped",
        ].includes(String(candidate.roleStatus))
          ? candidate.roleStatus
          : undefined;
        return [
          {
            phone,
            realName,
            models,
            ...(profileId ? { profileId } : {}),
            ...(roleName ? { roleName } : {}),
            ...(roleStatus ? { roleStatus } : {}),
          },
        ];
      });
    }
  } catch {
    configured = [];
  }

  const byPhone = new Map(
    configured.map((employee) => [employee.phone, employee] as const),
  );
  for (const phone of loadConfiguredEmployeePhones()) {
    if (!byPhone.has(phone)) {
      byPhone.set(phone, { phone, realName: "", models: [] });
    }
  }
  const employees = Array.from(byPhone.values());
  const currentEmployee = employees[employees.length - 1];

  return currentEmployee ? [currentEmployee] : [];
}

export function rememberConfiguredEmployee(
  employee: ConfiguredEmployee,
): ConfiguredEmployee[] {
  const phone = normalizeEmployeePhone(employee.phone);
  const next: ConfiguredEmployee[] = [];
  if (/^1\d{10}$/.test(phone)) {
    next.push({
      phone,
      realName: employee.realName.trim(),
      models: Array.from(
        new Set(employee.models.map((model) => model.trim()).filter(Boolean)),
      ),
      ...(employee.profileId?.trim()
        ? { profileId: employee.profileId.trim() }
        : {}),
      ...(employee.roleName?.trim()
        ? { roleName: employee.roleName.trim() }
        : {}),
      ...(employee.roleStatus ? { roleStatus: employee.roleStatus } : {}),
    });
  }
  try {
    window.localStorage.setItem(
      EMPLOYEE_CONFIGURATIONS_STORAGE_KEY,
      JSON.stringify(next),
    );
  } catch {
    // Return the updated in-memory list when storage is unavailable.
  }
  rememberConfiguredEmployeePhone(phone);
  return next;
}
