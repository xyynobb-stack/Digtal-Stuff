import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import Providers from "./Providers";

describe("employee-only provider screen", () => {
  beforeEach(() => {
    window.localStorage.clear();
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

  it("keeps each previously configured phone visible only once", () => {
    window.localStorage.setItem(
      "hermes.configuredEmployeePhones",
      JSON.stringify(["15703020935", "15703020935"]),
    );

    render(<Providers />);

    expect(screen.getByText("已配置手机号")).toBeTruthy();
    expect(screen.getAllByText("15703020935")).toHaveLength(1);
  });
});
