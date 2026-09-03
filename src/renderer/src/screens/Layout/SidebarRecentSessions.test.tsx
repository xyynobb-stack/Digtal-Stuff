import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchSessionTitleChanged } from "../../lib/sessionTitleEvents";
import SidebarRecentSessions from "./SidebarRecentSessions";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    locale: "zh-CN",
    setLocale: vi.fn(),
    t: (key: string) => key,
  }),
}));

describe("SidebarRecentSessions live titles", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("does not let an older cache request overwrite a live title", async () => {
    let resolveSync!: (value: Array<{ id: string; title: string }>) => void;
    const staleSync = new Promise<Array<{ id: string; title: string }>>(
      (resolve) => {
        resolveSync = resolve;
      },
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listCachedSessions: vi.fn(async () => [
          { id: "report-session", title: "Active session skills: report" },
        ]),
        syncSessionCache: vi.fn(() => staleSync),
      },
    });

    render(
      <SidebarRecentSessions
        open
        activeProfile="default"
        currentSessionId="report-session"
        loadingSessionIds={new Set()}
        resumingSessionId={null}
        onSelect={vi.fn()}
        scrollRootRef={createRef<HTMLDivElement>()}
      />,
    );

    expect(
      await screen.findByText("Active session skills: report"),
    ).toBeInTheDocument();
    act(() => {
      dispatchSessionTitleChanged({
        profile: "default",
        sessionId: "report-session",
        title: "人工智能行业市场调研报告",
      });
    });
    expect(screen.getByText("人工智能行业市场调研报告")).toBeInTheDocument();

    await act(async () => {
      resolveSync([
        { id: "report-session", title: "Active session skills: report" },
      ]);
      await staleSync;
    });

    await waitFor(() => {
      expect(screen.getByText("人工智能行业市场调研报告")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("Active session skills: report"),
    ).not.toBeInTheDocument();
  });

  it("keeps an old profile response from overwriting the newly selected profile", async () => {
    let resolveAlpha!: (value: Array<{ id: string; title: string }>) => void;
    const alphaSync = new Promise<Array<{ id: string; title: string }>>(
      (resolve) => {
        resolveAlpha = resolve;
      },
    );
    const syncSessionCache = vi.fn((profile: string) =>
      profile === "alpha"
        ? alphaSync
        : Promise.resolve([{ id: "beta-id", title: "Beta session" }]),
    );
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listCachedSessions: vi.fn(async () => []),
        syncSessionCache,
      },
    });

    const props = {
      open: true,
      currentSessionId: null,
      loadingSessionIds: new Set<string>(),
      resumingSessionId: null,
      onSelect: vi.fn(),
      scrollRootRef: createRef<HTMLDivElement>(),
    };
    const view = render(
      <SidebarRecentSessions {...props} activeProfile="alpha" />,
    );
    view.rerender(<SidebarRecentSessions {...props} activeProfile="beta" />);

    expect(await screen.findByText("Beta session")).toBeInTheDocument();
    await act(async () => {
      resolveAlpha([{ id: "alpha-id", title: "Alpha session" }]);
      await alphaSync;
    });

    expect(screen.getByText("Beta session")).toBeInTheDocument();
    expect(screen.queryByText("Alpha session")).not.toBeInTheDocument();
    expect(syncSessionCache).toHaveBeenCalledWith("alpha");
    expect(syncSessionCache).toHaveBeenCalledWith("beta");
  });

  it("refreshes the selected profile after a new session is created", async () => {
    // @lat: [[sidebar-navigation#Infinite sidebar list]]
    const syncSessionCache = vi.fn(async () => []);
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listCachedSessions: vi.fn(async () => []),
        syncSessionCache,
      },
    });

    const props = {
      open: true,
      loadingSessionIds: new Set<string>(),
      resumingSessionId: null,
      onSelect: vi.fn(),
      scrollRootRef: createRef<HTMLDivElement>(),
    };
    const view = render(
      <SidebarRecentSessions
        {...props}
        activeProfile="default"
        currentSessionId={null}
      />,
    );
    view.rerender(
      <SidebarRecentSessions
        {...props}
        activeProfile="employee-profile"
        currentSessionId={null}
      />,
    );

    await waitFor(() => {
      expect(syncSessionCache).toHaveBeenCalledWith("employee-profile");
    });
    syncSessionCache.mockClear();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 10_000);

    view.rerender(
      <SidebarRecentSessions
        {...props}
        activeProfile="employee-profile"
        currentSessionId="new-employee-session"
      />,
    );

    await waitFor(() => {
      expect(syncSessionCache).toHaveBeenCalledWith("employee-profile");
    });
    expect(syncSessionCache).not.toHaveBeenCalledWith("default");
  });
});
