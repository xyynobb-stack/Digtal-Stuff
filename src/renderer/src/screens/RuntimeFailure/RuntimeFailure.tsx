import HermesLogo from "../../components/common/HermesLogo";
import { Alert, Refresh } from "../../assets/icons";

interface RuntimeFailureProps {
  error: string;
  onRetry: () => void;
}

export default function RuntimeFailure({
  error,
  onRetry,
}: RuntimeFailureProps): React.JSX.Element {
  return (
    <div className="screen runtime-failure-screen">
      <HermesLogo size={54} />
      <div className="runtime-failure-icon" aria-hidden="true">
        <Alert size={24} />
      </div>
      <h1 className="runtime-failure-title">JingYuAI 运行时升级失败</h1>
      <p className="runtime-failure-subtitle">
        新版运行时未能安全启用。旧版 gateway/dashboard
        进程可能仍在运行，或文件被安全软件占用。
      </p>
      <pre className="runtime-failure-detail" data-selectable>
        {error}
      </pre>
      <p className="runtime-failure-hint">
        请关闭其他 JingYuAI 窗口后重试；无需重新安装应用。
      </p>
      <button className="btn btn-primary" onClick={onRetry}>
        <Refresh size={15} />
        重试运行时升级
      </button>
    </div>
  );
}
