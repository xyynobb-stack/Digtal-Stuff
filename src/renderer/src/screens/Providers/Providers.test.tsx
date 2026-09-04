import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Providers from "./Providers";
import type { EmployeeProfileBinding } from "../../../../shared/employee-workspace";

const binding: EmployeeProfileBinding = {
  schemaVersion: 1,
  provisionState: "ready",
  soulTemplateVersion: 1,
  roleCatalogVersion: 1,
  updatedAt: 1,
  employee: {
    userId: "a",
    username: "test",
    phone: "13987654321",
    realName: "张三",
    email: "",
  },
  role: {
    status: "configured",
    roleName: "项目经理",
    department: "研发部",
    position: "项目经理",
    roleId: "project-manager",
    mandatorySkills: [],
  },
};

describe("employee-only provider screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        getEmployeeProfileDetails: vi.fn(async () => null),
      },
    });
  });

  it("hands the activated Profile and mandatory skills to the desktop shell", async () => {
    // @lat: [[provider-setup#Provider setup#Employee phone provisioning#Employee workspace initialization tests#Immediate Profile activation]]
    const provisionEmployee = vi.fn(async () => ({
      ok: true as const,
      profileId: "employee-project-manager",
      userId: "employee-1",
      realName: "张三",
      models: ["Kimi-2.6"],
      fallbackConfigured: false,
      activated: true,
      role: {
        status: "configured" as const,
        department: "研发部",
        position: "项目经理",
        roleId: "project-manager",
        roleName: "项目经理",
        mandatorySkills: ["project-manager"],
      },
    }));
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        provisionEmployee,
        getEmployeeProfileDetails: vi.fn(async () => null),
      },
    });
    const onEmployeeProvisioned = vi.fn();
    render(<Providers onEmployeeProvisioned={onEmployeeProvisioned} />);

    fireEvent.change(screen.getByPlaceholderText("11 位手机号"), {
      target: { value: "13987654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "自动配置" }));

    await waitFor(() => {
      expect(onEmployeeProvisioned).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: "employee-project-manager",
          role: expect.objectContaining({
            mandatorySkills: ["project-manager"],
          }),
        }),
      );
    });
    expect(provisionEmployee).toHaveBeenCalledWith("13987654321");
  });

  it("shows employee phone provisioning without advanced provider controls", () => {
    const view = render(<Providers />);

    expect(screen.getByText("员工手机号快速配置")).toBeTruthy();
    expect(screen.getByPlaceholderText("11 位手机号")).toBeTruthy();
    expect(screen.getByRole("button", { name: "自动配置" })).toBeTruthy();
    expect(view.container.querySelectorAll(".settings-section")).toHaveLength(
      1,
    );
    expect(view.container.querySelector(".models-tabs")).toBeNull();
  });

  it("ignores cached employees when the current Profile is unbound", async () => {
    window.localStorage.setItem(
      "hermes.configuredEmployeePhones",
      JSON.stringify(["15703020935", "15703020935"]),
    );

    render(<Providers />);

    await screen.findByText("当前 Profile 尚未绑定员工，请先自动配置。");
    expect(screen.queryByText("15703020935")).toBeNull();
  });

  it("shows persisted binding without relying on browser storage", async () => {
    window.localStorage.setItem(
      "hermes.configuredEmployees",
      JSON.stringify([
        {
          phone: "13987654321",
          realName: "张三",
          models: ["Seedance-2.0"],
        },
      ]),
    );

    window.localStorage.clear();
    vi.mocked(window.hermesAPI.getEmployeeProfileDetails).mockResolvedValue({
      binding,
      models: ["Seedance-2.0"],
    } as Awaited<
      ReturnType<typeof window.hermesAPI.getEmployeeProfileDetails>
    >);
    render(<Providers profile="employee-a" />);

    await screen.findByText("已配置员工");
    expect(window.hermesAPI.getEmployeeProfileDetails).toHaveBeenCalledWith(
      "employee-a",
    );
    expect(screen.getByText("13987654321")).toBeTruthy();
    expect(screen.getByText("姓名")).toBeTruthy();
    expect(screen.getByText("张三")).toBeTruthy();
    expect(screen.getByText("Seedance-2.0")).toBeTruthy();
  });

  it("discards a previous Profile response and exposes read errors", async () => {
    let resolveOld!: (value: null) => void;
    vi.mocked(window.hermesAPI.getEmployeeProfileDetails)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error("read failed"));
    const view = render(<Providers profile="employee-a" />);
    view.rerender(<Providers profile="employee-b" />);
    await screen.findByText("员工信息读取失败，请重试。");
    await act(async () => {
      resolveOld(null);
    });
    expect(
      screen.queryByText("当前 Profile 尚未绑定员工，请先自动配置。"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("connects Feishu only for the displayed Profile and ignores late authorization results", async () => {
    let finishStart!: (value: { requestId: string; expiresIn: number }) => void;
    vi.mocked(window.hermesAPI.getEmployeeProfileDetails).mockResolvedValue({
      binding,
      models: [],
    } as Awaited<
      ReturnType<typeof window.hermesAPI.getEmployeeProfileDetails>
    >);
    window.hermesAPI.startFeishuOAuth = vi.fn(
      () =>
        new Promise<{ requestId: string; expiresIn: number }>((resolve) => {
          finishStart = resolve;
        }),
    );
    window.hermesAPI.getFeishuOAuthStatus = vi.fn();
    const view = render(<Providers profile="employee-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "连接飞书" }));
    expect(window.hermesAPI.startFeishuOAuth).toHaveBeenCalledWith(
      "employee-a",
    );
    view.rerender(<Providers profile="employee-b" />);
    await act(async () => {
      finishStart({ requestId: "old", expiresIn: 60 });
    });
    expect(window.hermesAPI.getFeishuOAuthStatus).not.toHaveBeenCalled();
    expect(
      screen.queryByText("正在打开飞书授权页面，请在浏览器中完成授权…"),
    ).toBeNull();
  });
});
