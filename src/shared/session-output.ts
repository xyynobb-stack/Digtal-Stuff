export type SessionOutputDestination = "desktop" | "context-folder";

export interface SessionContextSettings {
  folder: string | null;
  outputDestination: SessionOutputDestination;
}

export function normalizeSessionOutputDestination(
  value: unknown,
  folder?: string | null,
): SessionOutputDestination {
  return value === "context-folder" && Boolean(folder)
    ? "context-folder"
    : "desktop";
}
