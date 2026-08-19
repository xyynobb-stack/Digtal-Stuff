import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentInitializationBanner } from "./AgentInitializationBanner";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars?.seconds === undefined ? key : `${key}:${vars.seconds}`,
  }),
}));

describe("AgentInitializationBanner", () => {
  // @lat: [[chat-commands#Layered desktop readiness]]
  it("does not count background preparation as user wait time", () => {
    render(
      <AgentInitializationBanner
        status={{
          phase: "background",
          backgroundStartedAtMs: Date.now() - 4_000,
        }}
      />,
    );

    expect(screen.getByTestId("agent-initialization-banner")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText("chat.initialization.background")).toBeTruthy();
    expect(
      screen.queryByText(/chat\.initialization\.waitingElapsed:/),
    ).toBeNull();
  });

  it("starts elapsed time only when a sent message is waiting", () => {
    render(
      <AgentInitializationBanner
        status={{
          phase: "waiting",
          backgroundStartedAtMs: Date.now() - 30_000,
          blockingStartedAtMs: Date.now() - 4_000,
        }}
      />,
    );

    expect(screen.getByText("chat.initialization.waiting")).toBeTruthy();
    expect(
      screen.getByText(/chat\.initialization\.waitingElapsed:/),
    ).toBeTruthy();
  });

  it("keeps initialization errors visible as an alert", () => {
    render(
      <AgentInitializationBanner
        status={{
          phase: "failed",
          backgroundStartedAtMs: Date.now() - 1_000,
          detail: "MCP startup failed",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("MCP startup failed")).toBeTruthy();
  });
});
