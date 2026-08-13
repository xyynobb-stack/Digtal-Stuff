export interface WritingTemplate {
  id: string;
  name: string;
  /** Short user-provided explanation shown in template lists. */
  description?: string;
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

export interface ReplaceWritingTemplateResult {
  success: boolean;
  canceled?: boolean;
  template?: WritingTemplate;
  error?: string;
}
