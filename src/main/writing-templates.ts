import { createHash } from "crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, extname, join } from "path";
import type {
  ImportWritingTemplateResult,
  WritingTemplate,
} from "../shared/writing-templates";
import { profileHome } from "./utils";

const MAX_TEMPLATE_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".md",
  ".odt",
  ".pdf",
  ".rtf",
  ".txt",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
};

function templatesRoot(profile?: string): string {
  return join(profileHome(profile), "writing-templates");
}

function safeIdBase(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || "template";
}

function readTemplateMetadata(directory: string): WritingTemplate | null {
  try {
    const metadata = JSON.parse(
      readFileSync(join(directory, "metadata.json"), "utf8"),
    ) as Omit<WritingTemplate, "path">;
    if (
      !metadata.fileName ||
      basename(metadata.fileName) !== metadata.fileName
    ) {
      return null;
    }
    const path = join(directory, metadata.fileName);
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return { ...metadata, path };
  } catch {
    return null;
  }
}

// @lat: [[discover#Writing templates entry]]
export function listWritingTemplates(profile?: string): WritingTemplate[] {
  const root = templatesRoot(profile);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readTemplateMetadata(join(root, entry.name)))
    .filter((template): template is WritingTemplate => template !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Copy a template unchanged into profile-owned storage for later attachment. */
// @lat: [[discover#Writing templates entry]]
export function importWritingTemplate(
  sourcePath: string,
  profile?: string,
): ImportWritingTemplateResult {
  try {
    if (
      !sourcePath ||
      !existsSync(sourcePath) ||
      !statSync(sourcePath).isFile()
    ) {
      return { success: false, error: "选择的模板文件不存在。" };
    }
    const extension = extname(sourcePath).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return { success: false, error: "不支持该模板格式。" };
    }
    const size = statSync(sourcePath).size;
    if (size > MAX_TEMPLATE_BYTES) {
      return { success: false, error: "模板文件不能超过 50 MB。" };
    }

    const contents = readFileSync(sourcePath);
    const digest = createHash("sha256")
      .update(contents)
      .digest("hex")
      .slice(0, 12);
    const fileName = basename(sourcePath);
    const name = basename(sourcePath, extension);
    const id = `${safeIdBase(name)}-${digest}`;
    const directory = join(templatesRoot(profile), id);
    mkdirSync(directory, { recursive: true });
    const storedPath = join(directory, fileName);
    copyFileSync(sourcePath, storedPath);

    const template: WritingTemplate = {
      id,
      name,
      fileName,
      extension: extension.slice(1),
      mime: MIME_BY_EXTENSION[extension] || "application/octet-stream",
      size,
      createdAt: new Date().toISOString(),
      path: storedPath,
    };
    const { path: _path, ...metadata } = template;
    writeFileSync(
      join(directory, "metadata.json"),
      JSON.stringify(metadata, null, 2),
      "utf8",
    );
    return { success: true, template };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
