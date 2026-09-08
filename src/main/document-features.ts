import { app } from "electron";
import { spawn } from "child_process";
import { basename, extname, join } from "path";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import type {
  ContractAiAnalysisRequest,
  ContractComparisonResult,
  FeatureFileKind,
  FeatureOperationResult,
  FeaturePickedFile,
  OcrDocumentResult,
} from "../shared/feature-workspace";
import type { SessionModelOverride } from "../shared/model-override";
import { getHermesPython, HERMES_HOME } from "./installer";
import { sendMessage } from "./hermes";

const OCR_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".bmp",
  ".pdf",
]);
const CONTRACT_EXTENSIONS = new Set([".docx", ".pdf"]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;

function supportedExtensions(kind: FeatureFileKind): Set<string> {
  return kind === "ocr" ? OCR_EXTENSIONS : CONTRACT_EXTENSIONS;
}

export async function inspectFeatureFile(
  filePath: string,
  kind: FeatureFileKind,
): Promise<FeaturePickedFile> {
  const extension = extname(filePath).toLowerCase();
  if (!supportedExtensions(kind).has(extension)) {
    throw new Error(
      kind === "ocr" ? "请选择图片或 PDF 文件" : "请选择 DOCX 或 PDF 文件",
    );
  }
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("选择的路径不是文件");
  if (info.size > MAX_FILE_BYTES) throw new Error("单个文件不能超过 50 MB");
  return {
    path: filePath,
    name: basename(filePath),
    size: info.size,
    extension,
  };
}

function workerScriptPath(): string {
  return app.isPackaged
    ? join(
        process.resourcesPath,
        "app.asar.unpacked",
        "resources",
        "feature-workers",
        "document_tools.py",
      )
    : join(
        app.getAppPath(),
        "resources",
        "feature-workers",
        "document_tools.py",
      );
}

function featurePythonExecutable(): string {
  if (app.isPackaged) return getHermesPython();
  const venvRoot = join(
    app.getAppPath(),
    "build",
    "offline-runtime",
    "hermes-agent",
    "venv",
  );
  const candidates =
    process.platform === "win32"
      ? [
          join(venvRoot, "Scripts", "pythonw.exe"),
          join(venvRoot, "Scripts", "python.exe"),
        ]
      : [join(venvRoot, "bin", "python")];
  return (
    candidates.find((candidate) => existsSync(candidate)) || getHermesPython()
  );
}

// @lat: [[feature-workspace#Navigation and execution boundary]]
async function runWorker<T>(
  request: Record<string, unknown>,
  timeoutMs: number,
): Promise<FeatureOperationResult<T>> {
  return await new Promise((resolve) => {
    const child = spawn(featurePythonExecutable(), [workerScriptPath()], {
      cwd: HERMES_HOME,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        OMP_NUM_THREADS: "2",
        ORT_NUM_THREADS: "2",
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: FeatureOperationResult<T>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ success: false, error: "处理超时，请拆分文件后重试" });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 20 * 1024 * 1024) child.kill();
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      finish({ success: false, error: error.message }),
    );
    child.on("close", () => {
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) {
        finish({
          success: false,
          error: stderr.trim() || "文档处理进程没有返回结果",
        });
        return;
      }
      try {
        finish(JSON.parse(line) as FeatureOperationResult<T>);
      } catch {
        finish({
          success: false,
          error: stderr.trim() || "无法解析文档处理结果",
        });
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// @lat: [[feature-workspace#OCR]]
export async function runFeatureOcr(
  filePath: string,
): Promise<FeatureOperationResult<OcrDocumentResult>> {
  await inspectFeatureFile(filePath, "ocr");
  return runWorker<OcrDocumentResult>(
    { action: "ocr", path: filePath },
    10 * 60_000,
  );
}

export async function runContractComparison(
  oldPath: string,
  newPath: string,
): Promise<FeatureOperationResult<ContractComparisonResult>> {
  await Promise.all([
    inspectFeatureFile(oldPath, "contract"),
    inspectFeatureFile(newPath, "contract"),
  ]);
  return runWorker<ContractComparisonResult>(
    { action: "compare", oldPath, newPath },
    10 * 60_000,
  );
}

function analysisPrompt(request: ContractAiAnalysisRequest): string {
  const changed = request.comparison.differences
    .filter((item) => item.kind !== "unchanged")
    .slice(0, 300)
    .map((item) => ({
      ...item,
      oldText: item.oldText.slice(0, 4_000),
      newText: item.newText.slice(0, 4_000),
    }));
  const perspective =
    request.perspective === "party-a"
      ? "甲方"
      : request.perspective === "party-b"
        ? "乙方"
        : "中立";
  return [
    "你正在执行合同比对后的语义风险解读。不要调用任何工具，只分析下面提供的差异。",
    `分析立场：${perspective}。`,
    "请按“重要变化、潜在风险、建议复核事项”三部分输出中文结论；不要声称这是正式法律意见。",
    JSON.stringify(changed),
  ].join("\n\n");
}

// @lat: [[feature-workspace#Optional AI interpretation]]
export async function analyzeContractWithModel(
  request: ContractAiAnalysisRequest,
): Promise<FeatureOperationResult<string>> {
  if (!request.model.trim())
    return { success: false, error: "请先选择用于分析的模型" };
  const override: SessionModelOverride = {
    provider: request.provider,
    model: request.model,
    baseUrl: request.baseUrl,
  };
  return await new Promise((resolve) => {
    let output = "";
    let settled = false;
    let handle: { abort: () => void } | undefined;
    const finish = (result: FeatureOperationResult<string>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      handle?.abort();
      finish({ success: false, error: "AI 解读超时，请稍后重试" });
    }, 3 * 60_000);
    void sendMessage(
      analysisPrompt(request),
      {
        onChunk: (chunk) => {
          output += chunk;
        },
        onDone: () => finish({ success: true, data: output.trim() }),
        onError: (error) => finish({ success: false, error }),
      },
      request.profile,
      undefined,
      undefined,
      undefined,
      undefined,
      override,
    )
      .then((next) => {
        handle = next;
      })
      .catch((error: unknown) =>
        finish({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  });
}
