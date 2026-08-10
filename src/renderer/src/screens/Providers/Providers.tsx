import { useState } from "react";
import {
  loadConfiguredEmployeePhones,
  normalizeEmployeePhone,
  rememberConfiguredEmployeePhone,
} from "../../utils/employeePhones";

function Providers(): React.JSX.Element {
  const [employeePhone, setEmployeePhone] = useState("");
  const [employeeProvisioning, setEmployeeProvisioning] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [configuredEmployeePhones, setConfiguredEmployeePhones] = useState<
    string[]
  >(loadConfiguredEmployeePhones);

  async function handleProvisionEmployee(): Promise<void> {
    const normalized = normalizeEmployeePhone(employeePhone);
    setEmployeeProvisioning(true);
    setEmployeeError("");

    try {
      await window.hermesAPI.provisionEmployee(normalized);
      setConfiguredEmployeePhones(rememberConfiguredEmployeePhone(normalized));
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

  return (
    <div className="settings-container employee-provider-settings">
      <div className="settings-section">
        <div className="settings-section-title">员工手机号快速配置</div>
        <p className="settings-section-hint">
          输入手机号后自动获取员工 Key，并只显示该员工可用的聊天模型。
        </p>
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
        {configuredEmployeePhones.length > 0 && (
          <div className="settings-employee-configured" role="status">
            <div className="setup-employee-configured-title">已配置手机号</div>
            <div className="setup-employee-configured-list">
              {configuredEmployeePhones.map((phone) => (
                <span className="setup-employee-phone" key={phone}>
                  {phone}
                </span>
              ))}
            </div>
          </div>
        )}
        {employeeError && (
          <p className="settings-section-hint" role="alert">
            {employeeError}
          </p>
        )}
      </div>
    </div>
  );
}

export default Providers;
