import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

import { ApprovalCard } from "./ApprovalCard";
import type { ApprovalMessage } from "./types";

afterEach(cleanup);

const message: ApprovalMessage = {
  id: "approval-r1",
  kind: "approval",
  role: "agent",
  requestId: "r1",
  transport: "dashboard",
  description: "Write the Word report",
  command: "python generate.py",
  choices: ["once", "session", "deny"],
};

describe("ApprovalCard", () => {
  it("resumes the same request with the selected scope", async () => {
    const onRespond = vi.fn().mockResolvedValue(true);
    const onResolved = vi.fn();
    render(
      <ApprovalCard
        msg={message}
        onRespond={onRespond}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByText("chat.approval.once"));

    expect(onRespond).toHaveBeenCalledWith(message, "once");
    await vi.waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith("r1", "once"),
    );
  });

  it("keeps controls available when the runtime rejects a stale request", async () => {
    const onRespond = vi.fn().mockResolvedValue(false);
    const onResolved = vi.fn();
    render(
      <ApprovalCard
        msg={message}
        onRespond={onRespond}
        onResolved={onResolved}
      />,
    );

    fireEvent.click(screen.getByText("chat.approval.deny"));

    await vi.waitFor(() =>
      expect(screen.getByText("chat.approval.error")).toBeTruthy(),
    );
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByText("chat.approval.once")).toBeTruthy();
  });

  it("shows the recorded decision without interactive controls", () => {
    render(
      <ApprovalCard
        msg={{ ...message, resolved: true, choice: "session" }}
        onRespond={vi.fn()}
        onResolved={vi.fn()}
      />,
    );

    expect(screen.getByText("chat.approval.resolved")).toBeTruthy();
    expect(screen.queryByText("chat.approval.once")).toBeNull();
  });
});
