import { useI18n } from "./useI18n";

interface VerifyWarningBannerProps {
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Soft warning shown when checkInstall() succeeded (files exist) but the
 * deep `verifyInstall` probe failed. Retry re-runs startup verification; it
 * never launches an installer against a possibly managed runtime.
 */
function VerifyWarningBanner({
  onRetry,
  onDismiss,
}: VerifyWarningBannerProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="verify-warning-banner" role="status">
      <span className="verify-warning-text">{t("errors.verifyFailed")}</span>
      <div className="verify-warning-actions">
        <button
          className="btn btn-secondary btn-sm"
          onClick={onRetry}
          type="button"
        >
          {t("common.retry")}
        </button>
        <button className="btn-ghost btn-sm" onClick={onDismiss} type="button">
          {t("errors.verifyDismiss")}
        </button>
      </div>
    </div>
  );
}

export default VerifyWarningBanner;
