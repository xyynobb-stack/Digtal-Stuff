import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import { ReasoningRow, ToolActivityGroup } from "./HistoryRow";
import type {
  ReasoningMessage,
  ToolCallMessage,
  ToolResultMessage,
} from "./types";

afterEach(cleanup);

const agent = { name: "JingYu" };

describe("collapsed chat history", () => {
  it("mounts reasoning text only while the row is expanded", () => {
    const msg: ReasoningMessage = {
      id: "reasoning-1",
      kind: "reasoning",
      role: "agent",
      text: "private reasoning detail",
    };

    render(<ReasoningRow msg={msg} agent={agent} />);
    const toggle = screen.getByRole("button", { name: /chat\.thought/ });

    expect(screen.queryByText(msg.text)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(msg.text)).toBeVisible();
    fireEvent.click(toggle);
    expect(screen.queryByText(msg.text)).toBeNull();
  });

  it("mounts tool rows and each full payload only while opened", () => {
    const call: ToolCallMessage = {
      id: "call-1",
      kind: "tool_call",
      role: "agent",
      callId: "tool-1",
      name: "execute_code",
      args: `${"x".repeat(100)} hidden-call-payload`,
      status: "completed",
    };
    const result: ToolResultMessage = {
      id: "result-1",
      kind: "tool_result",
      role: "agent",
      callId: "tool-1",
      name: "execute_code",
      content: "hidden-result-payload",
    };
    const { container } = render(
      <ToolActivityGroup items={[call, result]} agent={agent} />,
    );
    const groupToggle = screen.getByRole("button");

    expect(container.querySelectorAll(".chat-tool-item")).toHaveLength(0);
    expect(screen.queryByText(call.args)).toBeNull();
    expect(screen.queryByText(result.content)).toBeNull();

    fireEvent.click(groupToggle);
    expect(container.querySelectorAll(".chat-tool-item")).toHaveLength(2);
    expect(screen.queryByText(call.args)).toBeNull();
    expect(screen.queryByText(result.content)).toBeNull();

    const itemToggles = container.querySelectorAll<HTMLButtonElement>(
      ".chat-tool-item-header",
    );
    fireEvent.click(itemToggles[0]);
    expect(screen.getByText(call.args)).toBeVisible();
    fireEvent.click(itemToggles[0]);
    expect(screen.queryByText(call.args)).toBeNull();

    fireEvent.click(itemToggles[1]);
    expect(screen.getByText(result.content)).toBeVisible();
    fireEvent.click(groupToggle);
    expect(container.querySelectorAll(".chat-tool-item")).toHaveLength(0);
    expect(screen.queryByText(result.content)).toBeNull();
  });
});
