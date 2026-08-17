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
  it("shows non-blocking progress while Agent construction is running", () => {
    render(
      <AgentInitializationBanner
        status={{ phase: "loading", startedAtMs: Date.now() - 4_000 }}
      />,
    );

    expect(screen.getByTestId("agent-initialization-banner")).toHaveAttribute(
      "role",
      "status",
    );
    expect(screen.getByText("chat.initialization.loading")).toBeTruthy();
    expect(screen.getByText(/chat\.initialization\.elapsed:/)).toBeTruthy();
  });

  it("keeps initialization errors visible as an alert", () => {
    render(
      <AgentInitializationBanner
        status={{
          phase: "failed",
          startedAtMs: Date.now() - 1_000,
          detail: "MCP startup failed",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("MCP startup failed")).toBeTruthy();
  });
});
