export type FeatureFileKind = "ocr" | "contract";

export interface FeaturePickedFile {
  path: string;
  name: string;
  size: number;
  extension: string;
}

export interface OcrPageResult {
  page: number;
  text: string;
  source: "text-layer" | "mineru" | "ocr";
  confidence?: number;
  blocks?: ContractDocumentBlock[];
}

export interface OcrDocumentResult {
  fileName: string;
  text: string;
  pages: OcrPageResult[];
  elapsedMs: number;
}

export type ContractDifferenceKind =
  | "added"
  | "removed"
  | "modified"
  | "unchanged";

export interface ContractDifference {
  id: string;
  kind: ContractDifferenceKind;
  oldText: string;
  newText: string;
  oldIndex?: number;
  newIndex?: number;
  similarity?: number;
  oldUnitId?: string;
  newUnitId?: string;
}

export interface ContractDocumentParagraph {
  type: "paragraph";
  id: string;
  text: string;
  style?: "heading";
  level?: number;
}

export interface ContractDocumentTableCell {
  id: string;
  text: string;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
}

export interface ContractDocumentTableRow {
  id: string;
  cells: ContractDocumentTableCell[];
}

export interface ContractDocumentTable {
  type: "table";
  id: string;
  tableIndex: number;
  columnWidths: number[];
  rows: ContractDocumentTableRow[];
}

export type ContractDocumentBlock =
  | ContractDocumentParagraph
  | ContractDocumentTable;

export interface ContractDocumentStructure {
  blocks: ContractDocumentBlock[];
}

export interface ContractComparisonResult {
  oldFileName: string;
  newFileName: string;
  differences: ContractDifference[];
  summary: Record<ContractDifferenceKind, number>;
  elapsedMs: number;
  oldDocument?: ContractDocumentStructure;
  newDocument?: ContractDocumentStructure;
}

export type ContractAnalysisPerspective = "neutral" | "party-a" | "party-b";
export type ContractAnalysisContext =
  | "changes-only"
  | "surrounding"
  | "full-document";

export interface ContractAiAnalysisRequest {
  profile: string;
  provider: string;
  model: string;
  baseUrl: string;
  perspective: ContractAnalysisPerspective;
  contextMode: ContractAnalysisContext;
  comparison: ContractComparisonResult;
}

export interface FeatureOperationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type FeatureHistoryKind = "ocr" | "contract-compare";

interface FeatureHistoryBaseInput {
  id?: string;
  profile: string;
  title: string;
}

export interface OcrFeatureHistoryInput extends FeatureHistoryBaseInput {
  kind: "ocr";
  file: FeaturePickedFile;
  result: OcrDocumentResult;
}

export interface ContractFeatureHistoryInput extends FeatureHistoryBaseInput {
  kind: "contract-compare";
  oldFile: FeaturePickedFile;
  newFile: FeaturePickedFile;
  result: ContractComparisonResult;
  analysis?: string;
  analysisModelId?: string;
  perspective?: ContractAnalysisPerspective;
  contextMode?: ContractAnalysisContext;
}

export type FeatureHistorySaveInput =
  | OcrFeatureHistoryInput
  | ContractFeatureHistoryInput;

export type FeatureHistoryRecord =
  | (OcrFeatureHistoryInput & {
      id: string;
      createdAt: number;
      updatedAt: number;
    })
  | (ContractFeatureHistoryInput & {
      id: string;
      createdAt: number;
      updatedAt: number;
    });

export interface FeatureHistorySummary {
  id: string;
  kind: FeatureHistoryKind;
  title: string;
  sourceNames: string[];
  createdAt: number;
  updatedAt: number;
}
