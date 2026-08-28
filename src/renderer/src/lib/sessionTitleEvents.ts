export const SESSION_TITLE_CHANGED_EVENT = "hermes-session-title-changed";

export interface SessionTitleChangedDetail {
  profile?: string;
  sessionId: string;
  title: string;
}

export function dispatchSessionTitleChanged(
  detail: SessionTitleChangedDetail,
): void {
  window.dispatchEvent(
    new CustomEvent<SessionTitleChangedDetail>(SESSION_TITLE_CHANGED_EVENT, {
      detail,
    }),
  );
}

export function sessionTitleChangedDetail(
  event: Event,
): SessionTitleChangedDetail | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail = event.detail as Partial<SessionTitleChangedDetail> | null;
  const sessionId = String(detail?.sessionId ?? "").trim();
  const title = String(detail?.title ?? "").trim();
  if (!sessionId || !title) return null;
  const profile = String(detail?.profile ?? "").trim();
  return {
    sessionId,
    title,
    ...(profile ? { profile } : {}),
  };
}
