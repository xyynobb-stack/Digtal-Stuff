import { useState } from "react";
import {
  loadConfiguredEmployees,
  normalizeEmployeePhone,
  rememberConfiguredEmployee,
} from "../../utils/employeePhones";

function Providers(): React.JSX.Element {
  const [employeePhone, setEmployeePhone] = useState("");
  const [employeeProvisioning, setEmployeeProvisioning] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [feishuConnectingPhone, setFeishuConnectingPhone] = useState("");
  const [feishuMessage, setFeishuMessage] = useState("");
  const [configuredEmployees, setConfiguredEmployees] = useState(
    loadConfiguredEmployees,
  );

  async function handleProvisionEmployee(): Promise<void> {
    const normalized = normalizeEmployeePhone(employeePhone);
    setEmployeeProvisioning(true);
    setEmployeeError("");

    try {
      const result = await window.hermesAPI.provisionEmployee(normalized);
      if (!result.activated) {
        setEmployeeError("已有更新的员工配置请求，本次结果未切换为当前员工。");
        return;
      }
      const realName = result.realName;
      setConfiguredEmployees(
        rememberConfiguredEmployee({
          phone: normalized,
          realName,
          models: result.models,
          profileId: result.profileId,
          roleName: result.role.roleName || undefined,
          roleStatus: result.role.status,
        }),
      );
      setEmployeePhone("");
      window.location.reload();
    } catch (error) {
      setEmployeeError(
        error instanceof Error ? error.message : "员工配置失败。",
      );
    } finally {
      setEmployeeProvisioning(false);
    }
  }

  async function handleConnectFeishu(
    phone: string,
    profileId?: string,
  ): Promise<void> {
    setFeishuConnectingPhone(phone);
    setEmployeeError("");
    setFeishuMessage("正在打开飞书授权页面，请在浏览器中完成授权…");
    try {
      const started = await window.hermesAPI.startFeishuOAuth(profileId);
      const deadline = Date.now() + started.expiresIn * 1000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        const result = await window.hermesAPI.getFeishuOAuthStatus(
          started.requestId,
          profileId,
        );
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
      setFeishuMessage("");
      setEmployeeError(
        error instanceof Error ? error.message : "飞书连接失败。",
      );
    } finally {
      setFeishuConnectingPhone("");
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
