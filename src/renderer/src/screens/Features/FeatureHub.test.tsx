import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FeatureHub from "./FeatureHub";

describe("FeatureHub", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listFeatureHistory: vi.fn().mockResolvedValue([]),
      },
    });
  });

  // @lat: [[feature-workspace#Navigation and execution boundary]]
  it("opens a feature and returns to the catalog without starting its engine", async () => {
    render(<FeatureHub profile="default" />);

    expect(screen.getByRole("heading", { name: "功能区" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /OCR 文字识别/ }));

    expect(
      await screen.findByRole("heading", { name: "OCR 文字识别" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回功能区" }));
    expect(screen.getByRole("heading", { name: "功能区" })).toBeInTheDocument();
  });
});
