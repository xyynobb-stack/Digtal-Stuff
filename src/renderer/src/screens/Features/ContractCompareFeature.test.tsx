import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ContractCompareFeature, {
  renderInlineDifference,
} from "./ContractCompareFeature";

const oldFile = {
  path: "C:\\contracts\\old.docx",
  name: "旧合同.docx",
  size: 100,
  extension: ".docx",
};
const newFile = {
  path: "C:\\contracts\\new.docx",
  name: "新合同.docx",
  size: 120,
  extension: ".docx",
};

describe("ContractCompareFeature", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        listModels: vi.fn().mockResolvedValue([
          {
            id: "claude-opus-5",
            name: "Claude Opus 5",
            provider: "company-platform-anthropic",
            providerLabel: "Company Platform Anthropic",
            model: "claude-opus-5",
            baseUrl: "http://example.test",
          },
        ]),
        getModelConfig: vi.fn().mockResolvedValue({
          model: "",
          provider: "",
        }),
        pickFeatureFile: vi
          .fn()
          .mockResolvedValueOnce(oldFile)
          .mockResolvedValueOnce(newFile),
        compareContracts: vi.fn().mockResolvedValue({
          success: true,
          data: {
            oldFileName: oldFile.name,
            newFileName: newFile.name,
            elapsedMs: 15,
            summary: { added: 0, removed: 0, modified: 1, unchanged: 1 },
            oldDocument: {
              blocks: [
                { type: "paragraph", id: "old-p1", text: "第一条 服务范围" },
                {
                  type: "table",
                  id: "old-t1",
                  tableIndex: 1,
                  columnWidths: [1, 2],
                  rows: [
                    {
                      id: "old-t1-r1",
                      cells: [
                        {
                          id: "old-cell1",
                          text: "第二条 金额为100元",
                          row: 1,
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
            newDocument: {
              blocks: [
                { type: "paragraph", id: "new-p1", text: "第一条 服务范围" },
                {
                  type: "table",
                  id: "new-t1",
                  tableIndex: 1,
                  columnWidths: [1, 2],
                  rows: [
                    {
                      id: "new-t1-r1",
                      cells: [
                        {
                          id: "new-cell1",
                          text: "第二条 金额为200元",
                          row: 1,
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
            differences: [
              {
                id: "diff-1",
                kind: "unchanged",
                oldText: "第一条 服务范围",
                newText: "第一条 服务范围",
                oldIndex: 1,
                newIndex: 1,
                oldUnitId: "old-p1",
                newUnitId: "new-p1",
              },
              {
                id: "diff-2",
                kind: "modified",
                oldText: "第二条 金额为100元",
                newText: "第二条 金额为200元",
                oldIndex: 2,
                newIndex: 2,
                oldUnitId: "old-cell1",
                newUnitId: "new-cell1",
              },
            ],
          },
        }),
        analyzeContract: vi.fn().mockResolvedValue({
          success: true,
          data: "## 重要变化\n\n- **金额**由 100 元调整为 200 元。",
        }),
        exportContractAnalysis: vi.fn().mockResolvedValue({
          success: true,
          data: "C:\\exports\\合同AI分析.docx",
        }),
        listFeatureHistory: vi.fn().mockResolvedValue([]),
        saveFeatureHistory: vi.fn().mockImplementation(async (input) => ({
          ...input,
          id: "contract-history-1",
          createdAt: 1,
          updatedAt: 1,
        })),
        getFeatureHistory: vi.fn().mockResolvedValue(null),
        deleteFeatureHistory: vi.fn().mockResolvedValue(true),
      },
    });
  });

  // @lat: [[feature-workspace#Contract comparison#Side-by-side review]]
  it("renders both documents and a navigable change summary", async () => {
    class NarrowResizeObserver {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }

      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 820 },
            } as ResizeObserverEntry,
          ],
          this as unknown as ResizeObserver,
        );
      }

      disconnect(): void {
        // No observer resources are allocated by this test double.
      }
      unobserve(): void {
        // No observed targets are retained by this test double.
      }
    }
    vi.stubGlobal("ResizeObserver", NarrowResizeObserver);

    render(<ContractCompareFeature profile="default" />);
    fireEvent.click(screen.getByRole("button", { name: /选择旧版合同/ }));
    expect(await screen.findByText("旧合同.docx")).toHaveAttribute(
      "title",
      "旧合同.docx",
    );
    fireEvent.click(screen.getByRole("button", { name: /选择新版合同/ }));
    await screen.findByText("新合同.docx");
    const compareButton = screen.getByRole("button", {
      name: "开始精确比对",
    });
    await waitFor(() => expect(compareButton).toBeEnabled());
    fireEvent.click(compareButton);

    expect(await screen.findByText("比对结果")).toBeInTheDocument();
    expect(screen.getAllByText("旧合同.docx")).toHaveLength(2);
    expect(screen.getAllByText("新合同.docx")).toHaveLength(2);
    expect(screen.getByText("1 处变化")).toBeInTheDocument();
    expect(screen.getByText("1 / 1 处变化")).toBeInTheDocument();
    expect(screen.getAllByText(/第二条 金额为/)).toHaveLength(3);
    expect(screen.getByLabelText("差异类型")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "比对结果列表" }),
    ).toHaveAttribute("tabindex", "0");
    expect(screen.getAllByRole("table")).toHaveLength(2);
    expect(screen.getAllByRole("cell")[0]).toHaveAttribute("colspan", "2");
    expect(window.hermesAPI.saveFeatureHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "default",
        kind: "contract-compare",
        oldFile,
        newFile,
      }),
    );

    const resultToggle = screen.getByRole("button", {
      name: "展开比对结果",
    });
    expect(resultToggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(resultToggle);
    expect(
      screen.getByRole("button", { name: "收起比对结果" }),
    ).toHaveAttribute("aria-expanded", "true");

    const resizer = screen.getByRole("separator", {
      name: "调整左右合同宽度",
    });
    expect(resizer).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(resizer, { key: "ArrowLeft" });
    expect(resizer).toHaveAttribute("aria-valuenow", "45");
    fireEvent.doubleClick(resizer);
    expect(resizer).toHaveAttribute("aria-valuenow", "50");
  });

  it("highlights only the changed middle of a modified paragraph", () => {
    const { container } = render(
      <>
        {renderInlineDifference(
          "金额为100元",
          "金额为200元",
          "modified",
          "old",
        )}
      </>,
    );
    expect(container.querySelector("mark")?.textContent).toBe("1");
    expect(container.textContent).toBe("金额为100元");
  });

  it("does not highlight the remaining text on the new side of a deletion", () => {
    const oldSide = render(
      <>{renderInlineDifference("文档管理", "管理", "modified", "old")}</>,
    );
    expect(oldSide.container.querySelector("mark")?.textContent).toBe("文档");
    expect(oldSide.container.textContent).toBe("文档管理");
    oldSide.unmount();

    const newSide = render(
      <>{renderInlineDifference("管理", "文档管理", "modified", "new")}</>,
    );
    expect(newSide.container.querySelector("mark")).toBeNull();
    expect(newSide.container.textContent).toBe("管理");
  });

  it("does not highlight the existing text on the old side of an insertion", () => {
    const oldSide = render(
      <>{renderInlineDifference("管理", "文档管理", "modified", "old")}</>,
    );
    expect(oldSide.container.querySelector("mark")).toBeNull();
    expect(oldSide.container.textContent).toBe("管理");
    oldSide.unmount();

    const newSide = render(
      <>{renderInlineDifference("文档管理", "管理", "modified", "new")}</>,
    );
    expect(newSide.container.querySelector("mark")?.textContent).toBe("文档");
    expect(newSide.container.textContent).toBe("文档管理");
  });

  it("keeps the shortened number unmarked after a character deletion", () => {
    const oldSide = render(
      <>{renderInlineDifference("250000", "25000", "modified", "old")}</>,
    );
    expect(oldSide.container.querySelector("mark")?.textContent).toBe("0");
    oldSide.unmount();

    const newSide = render(
      <>{renderInlineDifference("25000", "250000", "modified", "new")}</>,
    );
    expect(newSide.container.querySelector("mark")).toBeNull();
    expect(newSide.container.textContent).toBe("25000");
  });

  // @lat: [[feature-workspace#Optional AI interpretation#Word export]]
  it("exports the completed AI analysis as a Word document", async () => {
    render(<ContractCompareFeature profile="default" />);
    fireEvent.click(screen.getByRole("button", { name: /选择旧版合同/ }));
    await screen.findByText("旧合同.docx");
    fireEvent.click(screen.getByRole("button", { name: /选择新版合同/ }));
    await screen.findByText("新合同.docx");
    fireEvent.click(screen.getByRole("button", { name: "开始精确比对" }));
    await screen.findByText("比对结果");

    const analyzeButton = screen.getByRole("button", { name: "生成 AI 解读" });
    await waitFor(() => expect(analyzeButton).toBeEnabled());
    fireEvent.click(analyzeButton);
    expect(
      await screen.findByText(/金额.*100 元调整为 200 元/),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导出 Word" }));
    await waitFor(() =>
      expect(window.hermesAPI.exportContractAnalysis).toHaveBeenCalledWith({
        analysis: "## 重要变化\n\n- **金额**由 100 元调整为 200 元。",
        oldFileName: "旧合同.docx",
        newFileName: "新合同.docx",
        modelName: "Company Platform Anthropic · Claude Opus 5",
        perspective: "neutral",
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "C:\\exports\\合同AI分析.docx",
    );
  });
});
