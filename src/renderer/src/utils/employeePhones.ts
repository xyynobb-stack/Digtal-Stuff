const EMPLOYEE_PHONES_STORAGE_KEY = "hermes.configuredEmployeePhones";

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
  const next = Array.from(
    new Set([...loadConfiguredEmployeePhones(), normalized]),
  ).filter((value) => /^1\d{10}$/.test(value));
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
