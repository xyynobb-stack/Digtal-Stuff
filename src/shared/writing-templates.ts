export interface WritingTemplate {
  id: string;
  name: string;
  fileName: string;
  extension: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Absolute path to the unchanged imported source file. */
  path: string;
}

export interface ImportWritingTemplateResult {
  success: boolean;
  canceled?: boolean;
  template?: WritingTemplate;
  error?: string;
}
