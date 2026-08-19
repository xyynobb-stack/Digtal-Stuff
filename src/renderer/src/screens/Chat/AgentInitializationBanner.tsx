import { AlertTriangle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../components/useI18n";
import type { AgentInitializationStatus } from "./hooks/useDashboardChatTransport";

interface AgentInitializationBannerProps {
  status: AgentInitializationStatus;
}

/** Honest, non-blocking progress for the deferred Agent cold-start path. */
export function AgentInitializationBanner({
  status,
}: AgentInitializationBannerProps): React.JSX.Element {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  const terminal = status.phase === "ready" || status.phase === "failed";
  const blockingStartedAtMs = status.blockingStartedAtMs;

  useEffect(() => {
    if (terminal || blockingStartedAtMs === undefined) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [blockingStartedAtMs, terminal]);

  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - (blockingStartedAtMs ?? now)) / 1_000),
  );
  const messageKey = `chat.initialization.${status.phase}`;
  const Icon =
    status.phase === "failed"
      ? AlertTriangle
      : status.phase === "ready"
        ? CheckCircle2
        : LoaderCircle;

  return (
    <div
      className={`agent-initialization-banner agent-initialization-banner--${status.phase}`}
      role={status.phase === "failed" ? "alert" : "status"}
      aria-live="polite"
      data-testid="agent-initialization-banner"
    >
      <Icon
        aria-hidden
        className={terminal ? undefined : "agent-initialization-spinner"}
        size={18}
      />
      <div className="agent-initialization-copy">
        <strong>{t("chat.initialization.title")}</strong>
        <span>{t(messageKey)}</span>
        {!terminal && blockingStartedAtMs !== undefined && (
          <small>
            {t("chat.initialization.waitingElapsed", {
              seconds: elapsedSeconds,
            })}
          </small>
        )}
        {status.phase === "failed" && status.detail && (
          <small className="agent-initialization-error">{status.detail}</small>
        )}
      </div>
    </div>
  );
}
