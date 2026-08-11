import { useState } from "react";
import {
  loadConfiguredEmployees,
  normalizeEmployeePhone,
  rememberConfiguredEmployee,
} from "../../utils/employeePhones";

interface ProvidersProps {
  profile?: string;
}

function Providers({ profile = "default" }: ProvidersProps): React.JSX.Element {
  const [employeePhone, setEmployeePhone] = useState("");
  const [employeeProvisioning, setEmployeeProvisioning] = useState(false);
  const [employeeError, setEmployeeError] = useState("");
  const [configuredEmployees, setConfiguredEmployees] = useState(
    loadConfiguredEmployees,
  );

  async function handleProvisionEmployee(): Promise<void> {
    const normalized = normalizeEmployeePhone(employeePhone);
    setEmployeeProvisioning(true);
    setEmployeeError("");

    try {
      const result = await window.hermesAPI.provisionEmployee(normalized);
      const realName = result.realName;
      if (realName) {
        const renamed = await window.hermesAPI.setProfileName(
          profile,
          realName,
        );
        if (!renamed.success) {
          throw new Error(renamed.error || "姓名自动填写失败。");
        }
      }
      setConfiguredEmployees(
        rememberConfiguredEmployee({
          phone: normalized,
          realName,
          models: result.models,
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
      </div>
    </div>
  );
}

export default Providers;
