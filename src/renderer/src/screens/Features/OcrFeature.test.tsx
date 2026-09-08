import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import OcrFeature from "./OcrFeature";

describe("OcrFeature", () => {
  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        pickFeatureFile: vi.fn().mockResolvedValue({
          path: "C:\\contracts\\scan.pdf",
          name: "scan.pdf",
          size: 100,
          extension: ".pdf",
        }),
        runFeatureOcr: vi.fn().mockResolvedValue({
          success: true,
          data: {
            fileName: "scan.pdf",
            elapsedMs: 1200,
            text: "委托事项\n\n序号\t项目\n1\t云桌面服务\n合计",
            pages: [
              {
                page: 1,
                source: "mineru",
                text: "委托事项\n\n序号\t项目\n1\t云桌面服务\n合计",
                blocks: [
                  {
                    type: "paragraph",
                    id: "ocr-page-1-p1",
                    text: "委托事项",
                    style: "heading",
                    level: 2,
                  },
                  {
                    type: "table",
                    id: "ocr-page-1-t1",
                    tableIndex: 1,
                    columnWidths: [1, 1],
                    rows: [
                      {
                        id: "row-1",
                        cells: [
                          {
                            id: "cell-1",
                            text: "序号",
                            row: 1,
                            column: 1,
                            rowSpan: 1,
                            colSpan: 1,
                          },
                          {
                            id: "cell-2",
                            text: "项目",
                            row: 1,
                            column: 2,
                            rowSpan: 1,
                            colSpan: 1,
                          },
                        ],
                      },
                      {
                        id: "row-2",
                        cells: [
                          {
                            id: "cell-3",
                            text: "合计",
                            row: 2,
                            column: 1,
                            rowSpan: 1,
                            colSpan: 2,
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      },
    });
  });

  // @lat: [[feature-workspace#OCR]]
  it("renders MinerU headings and merged tables without raw markup", async () => {
    const { container } = render(<OcrFeature />);
    fireEvent.click(screen.getByRole("button", { name: /选择图片或 PDF/ }));
    await screen.findByText("scan.pdf");
    const runButton = screen.getByRole("button", { name: "开始识别" });
    await waitFor(() => expect(runButton).toBeEnabled());
    fireEvent.click(runButton);

    expect(await screen.findByText("委托事项")).toHaveClass(
      "feature-ocr-heading",
    );
    expect(container.querySelector("table.feature-ocr-table")).not.toBeNull();
    expect(screen.getByText("合计")).toHaveAttribute("colspan", "2");
    expect(container).not.toHaveTextContent("<table>");
    expect(container).not.toHaveTextContent("images/");
  });
});
