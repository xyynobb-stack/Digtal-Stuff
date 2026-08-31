import { memo, useState } from "react";
import { useI18n } from "../../components/useI18n";
import type { ApprovalChoice, ApprovalMessage } from "./types";

interface ApprovalCardProps {
  msg: ApprovalMessage;
  onRespond: (msg: ApprovalMessage, choice: ApprovalChoice) => Promise<boolean>;
  onResolved: (requestId: string, choice: ApprovalChoice) => void;
}

// @lat: [[chat-commands#Mid-turn approvals]]
export const ApprovalCard = memo(function ApprovalCard({
  msg,
  onRespond,
  onResolved,
}: ApprovalCardProps): React.JSX.Element {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState<ApprovalChoice | null>(null);
  const [error, setError] = useState(false);

  const submit = async (choice: ApprovalChoice): Promise<void> => {
    if (msg.resolved || submitting) return;
    setSubmitting(choice);
    setError(false);
    try {
      const delivered = await onRespond(msg, choice);
      if (!delivered) {
        setError(true);
        return;
      }
      onResolved(msg.requestId, choice);
    } catch {
      setError(true);
    } finally {
      setSubmitting(null);
    }
  };

  const label = (choice: ApprovalChoice): string => {
    if (choice === "once") return t("chat.approval.once");
    if (choice === "session") return t("chat.approval.session");
    if (choice === "always") return t("chat.approval.always");
    return t("chat.approval.deny");
  };

  return (
    <div
      className={`chat-approval-card${msg.resolved ? " chat-approval-card--resolved" : ""}`}
    >
      <div className="chat-approval-title">{t("chat.approval.title")}</div>
      {msg.description && (
        <div className="chat-approval-description">{msg.description}</div>
      )}
      {msg.command && (
        <pre className="chat-approval-command">{msg.command}</pre>
      )}
      {msg.resolved ? (
        <div className="chat-approval-decision">
          {t("chat.approval.resolved", { choice: label(msg.choice ?? "deny") })}
        </div>
      ) : (
        <div className="chat-approval-actions">
          {msg.choices.map((choice) => (
            <button
              key={choice}
              type="button"
              className={`chat-approval-action chat-approval-action--${choice}`}
              disabled={submitting !== null}
              onClick={() => void submit(choice)}
            >
              {submitting === choice
                ? t("chat.approval.submitting")
                : label(choice)}
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="chat-approval-error" role="alert">
          {t("chat.approval.error")}
        </div>
      )}
    </div>
  );
});
