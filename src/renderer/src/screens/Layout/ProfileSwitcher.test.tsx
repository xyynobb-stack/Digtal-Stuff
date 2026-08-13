import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string): string => (key === "common.appName" ? "JingYuAI" : key),
  }),
}));

const { openProfile } = vi.hoisted(() => ({ openProfile: vi.fn() }));

vi.mock("../../components/profile/ProfileModalContext", () => ({
  useProfileModal: () => ({
    openProfile,
  }),
}));

vi.mock("../../components/common/ProfileAvatar", () => ({
  default: ({ name }: { name: string }): React.JSX.Element => (
    <span data-testid={`avatar-${name}`} />
  ),
}));

import ProfileSwitcher from "./ProfileSwitcher";

interface ProfileInfo {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  model: string;
  skillCount: number;
  gatewayRunning: boolean;
}

function installHermesAPI(profiles: ProfileInfo[]): void {
  Object.defineProperty(window, "hermesAPI", {
    configurable: true,
    value: {
      listProfiles: vi.fn().mockResolvedValue(profiles),
      setActiveProfile: vi.fn().mockResolvedValue(undefined),
    },
  });
}

function profile(id: string, name = id): ProfileInfo {
  return {
    id,
    name,
    isDefault: id === "default",
    isActive: id === "default",
    model: "",
    skillCount: 0,
    gatewayRunning: false,
  };
}

const menuActions = {
  onOpenProviders: vi.fn(),
  onOpenTools: vi.fn(),
  onOpenMemory: vi.fn(),
  onOpenSettings: vi.fn(),
};

describe("ProfileSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the app name for an unrenamed default profile", async () => {
    installHermesAPI([profile("default")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
        {...menuActions}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("JingYuAI")).toBeInTheDocument();
    });
  });

  it("shows a custom default profile name when one is set", async () => {
    installHermesAPI([profile("default", "卢姐")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
        {...menuActions}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("卢姐")).toBeInTheDocument();
    });
  });

  it("moves profile and workspace actions into the upward account menu", async () => {
    installHermesAPI([profile("default", "卢姐")]);

    render(
      <ProfileSwitcher
        activeProfile="default"
        onSwitch={() => {}}
        onManage={() => {}}
        {...menuActions}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "卢姐 用户菜单",
    });
    fireEvent.click(trigger);

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Profile" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "navigation.providers" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "navigation.tools" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "navigation.memory" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "navigation.settings" }),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("menuitem", { name: "Profile" }));
    expect(openProfile).toHaveBeenCalledWith("default", expect.any(Object));

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "navigation.tools" }));
    expect(menuActions.onOpenTools).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
