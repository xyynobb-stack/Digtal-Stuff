import { useEffect, useRef, useState } from "react";
import {
  type ConfiguredEmployee,
  normalizeEmployeePhone,
  rememberConfiguredEmployee,
} from "../../utils/employeePhones";
import type { EmployeeProvisionResult } from "../../../../shared/employee-workspace";

interface ProvidersProps {
  profile?: string;
  onEmployeeProvisioned?: (result: EmployeeProvisionResult) => void;
}

function Providers({
  profile = "default",
  onEmployeeProvisioned,
}: ProvidersProps): React.JSX.Element {
  const [employeePhone, setEmployeePhone] = useState("");
  const [employeeProvisioning, setEmployeeProvisioning] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [feishuConnectingPhone, setFeishuConnectingPhone] = useState("");
  const [feishuMessage, setFeishuMessage] = useState("");
  const [details, setDetails] = useState<{
    profile: string;
    employee: ConfiguredEmployee | null;
    error: string;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const generation = ++epoch.current;
    setDetails(null);
    setFeishuMessage("");
    setFeishuConnectingPhone("");
    setEmployeeError("");
    void window.hermesAPI
      .getEmployeeProfileDetails(profile)
      .then((result) => {
        if (epoch.current !== generation) return;
        const employee = result
          ? {
              phone: result.binding.employee.phone,
              realName: result.binding.employee.realName,
              models: result.models,
              profileId: profile,
              roleName: result.binding.role.roleName || undefined,
              roleStatus: result.binding.role.status,
            }
          : null;
        setDetails({ profile, employee, error: "" });
      })
      .catch(() => {
        if (epoch.current === generation)
          setDetails({
            profile,
            employee: null,
            error: "员工信息读取失败，请重试。",
          });
      });
    return () => {
      epoch.current = generation + 1;
    };
  }, [profile, refresh]);
  const currentDetails = details?.profile === profile ? details : null;
  const configuredEmployees = currentDetails?.employee
    ? [currentDetails.employee]
    : [];

  async function handleProvisionEmployee(): Promise<void> {
    const generation = epoch.current;
    const normalized = normalizeEmployeePhone(employeePhone);
    setEmployeeProvisioning(true);
    setEmployeeError("");

    try {
      const result = await window.hermesAPI.provisionEmployee(normalized);
      if (epoch.current !== generation) return;
      if (!result.activated) {
        setEmployeeError("已有更新的员工配置请求，本次结果未切换为当前员工。");
        return;
      }
      const realName = result.realName;
      rememberConfiguredEmployee({
        phone: normalized,
        realName,
        models: result.models,
        profileId: result.profileId,
        roleName: result.role.roleName || undefined,
        roleStatus: result.role.status,
      });
      setRefresh((value) => value + 1);
      setEmployeePhone("");
      onEmployeeProvisioned?.(result);
    } catch (error) {
      if (epoch.current !== generation) return;
      setEmployeeError(
        error instanceof Error ? error.message : "员工配置失败。",
      );
    } finally {
      if (epoch.current === generation) setEmployeeProvisioning(false);
    }
  }

  async function handleConnectFeishu(
    phone: string,
    profileId?: string,
  ): Promise<void> {
    if (profileId !== profile || !currentDetails?.employee) return;
    const generation = epoch.current;
    setFeishuConnectingPhone(phone);
    setEmployeeError("");
    setFeishuMessage("正在打开飞书授权页面，请在浏览器中完成授权…");
    try {
      const started = await window.hermesAPI.startFeishuOAuth(profileId);
      if (epoch.current !== generation) return;
      const deadline = Date.now() + started.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (epoch.current !== generation) return;
        const result = await window.hermesAPI.getFeishuOAuthStatus(
          started.requestId,
          profileId,
        );
        if (epoch.current !== generation) return;
        if (result.status === "connected") {
          setFeishuMessage("飞书连接成功，可以关闭浏览器授权页面。");
          return;
        }
        if (result.status === "failed") {
          throw new Error(result.error || "飞书授权失败，请重试。");
        }
        if (result.status === "expired") {
          throw new Error("飞书授权已超时，请重新连接。");
        }
      }
      throw new Error("飞书授权已超时，请重新连接。");
    } catch (error) {
      if (epoch.current !== generation) return;
      setFeishuMessage("");
      setEmployeeError(
        error instanceof Error ? error.message : "飞书连接失败。",
      );
    } finally {
      if (epoch.current === generation) setFeishuConnectingPhone("");
    }
  }

  return (
    <div className="settings-container employee-provider-settings">
      <div className="settings-section">
        <div className="settings-section-title">员工手机号快速配置</div>
        <div className="settings-gateway-row">
          <input
            className="input"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            placeholder="11 位手机号"
            value={employeePhone}
            onChange={(event) => setEmployeePhone(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                employeePhone.trim() &&
                !employeeProvisioning
              ) {
                void handleProvisionEmployee();
              }
            }}
          />
          <button
            className="btn btn-primary"
            disabled={employeeProvisioning || !employeePhone.trim()}
            onClick={() => void handleProvisionEmployee()}
          >
            {employeeProvisioning ? "配置中…" : "自动配置"}
          </button>
        </div>
        {!currentDetails && <p role="status">正在读取当前员工信息…</p>}
        {currentDetails?.error && (
          <p role="alert">
            {currentDetails.error}
            <button onClick={() => setRefresh((value) => value + 1)}>
              重试
            </button>
          </p>
        )}
        {currentDetails &&
          !currentDetails.error &&
          !currentDetails.employee && (
            <p role="status">当前 Profile 尚未绑定员工，请先自动配置。</p>
          )}
        {configuredEmployees.length > 0 && (
          <div className="settings-employee-configured" role="status">
            <div className="setup-employee-configured-title">已配置员工</div>
            <div className="employee-configured-list">
              {configuredEmployees.map((employee) => (
                <div className="employee-configured-card" key={employee.phone}>
                  <div className="employee-configured-row">
                    <span>手机号</span>
                    <strong>{employee.phone}</strong>
                  </div>
                  <div className="employee-configured-row">
                    <span>姓名</span>
                    <strong>{employee.realName || "重新配置后显示"}</strong>
                  </div>
                  <div className="employee-configured-row">
                    <span>岗位</span>
                    <strong>
                      {employee.roleName ||
                        (employee.roleStatus === "unmapped"
                          ? "岗位能力待配置"
                          : "等待接口返回")}
                    </strong>
                  </div>
                  <div className="employee-configured-models">
                    <span>可用模型</span>
                    <div className="employee-configured-model-list">
                      {employee.models.length > 0 ? (
                        employee.models.map((model) => (
                          <span className="setup-employee-phone" key={model}>
                            {model}
                          </span>
                        ))
                      ) : (
                        <strong>重新配置后显示</strong>
                      )}
                    </div>
                  </div>
                  <div className="settings-gateway-row">
                    <button
                      className="btn btn-primary"
                      disabled={feishuConnectingPhone === employee.phone}
                      onClick={() =>
                        void handleConnectFeishu(
                          employee.phone,
                          employee.profileId,
                        )
                      }
                    >
                      {feishuConnectingPhone === employee.phone
                        ? "等待飞书授权…"
                        : "连接飞书"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {employeeError && (
          <p className="settings-section-hint" role="alert">
            {employeeError}
          </p>
        )}
        {feishuMessage && (
          <p className="settings-section-hint" role="status">
            {feishuMessage}
          </p>
        )}
      </div>
    </div>
  );
}

export default Providers;
