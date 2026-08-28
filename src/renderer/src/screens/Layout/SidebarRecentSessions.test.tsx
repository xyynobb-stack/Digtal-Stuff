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
});
