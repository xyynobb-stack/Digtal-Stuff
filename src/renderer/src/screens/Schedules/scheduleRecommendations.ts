import type { WritingTemplate } from "../../../../shared/writing-templates";

export type ReportRecommendationType = "daily-report" | "weekly-report";

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

export interface ReportRecommendationInput {
  type: ReportRecommendationType;
  employeeName: string;
  workContent: string;
  startDate: DateParts;
  endDate?: DateParts;
  template: WritingTemplate;
}

export function requiredSkillsForTemplate(
  template: WritingTemplate,
): string[] | undefined {
  return ["xls", "xlsx"].includes(template.extension.toLowerCase())
    ? ["xlsx"]
    : undefined;
}

export function datePartsToIso(parts: DateParts): string {
  return `${parts.year.toString().padStart(4, "0")}-${parts.month
    .toString()
    .padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function compareDateParts(left: DateParts, right: DateParts): number {
  return datePartsToIso(left).localeCompare(datePartsToIso(right));
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

export function buildReportRecommendationPrompt(
  input: ReportRecommendationInput,
): string {
  const isWeekly = input.type === "weekly-report";
  const reportLabel = isWeekly ? "周报汇总" : "日报汇总";
  const dateDescription = isWeekly
    ? `${datePartsToIso(input.startDate)} 至 ${datePartsToIso(
        input.endDate ?? input.startDate,
      )}`
    : datePartsToIso(input.startDate);

  const excelRequirements = requiredSkillsForTemplate(input.template)
    ? [
        "6. This is an Excel-only task. Use the activated xlsx skill and its workbook tools.",
        "7. First copy the original Excel template to a new file in the configured output directory, then fill that copy. Never overwrite the original template.",
        "8. The final deliverable must be an Excel workbook with the same extension as the template. Do not create or output a Word/DOC/DOCX document, PDF, or replacement text report.",
      ]
    : [];

  return [
    `请生成一份${reportLabel}，并严格使用指定写作模板完成。`,
    `模板名称：${input.template.name}`,
    `模板文件绝对路径：${input.template.path}`,
    `模板格式：${input.template.extension.toUpperCase()}`,
    `姓名：${input.employeeName.trim()}`,
    `工作日期：${dateDescription}`,
    "工作内容：",
    input.workContent.trim(),
    "执行要求：",
    "1. 先读取模板原文件，保留模板的结构、栏目、样式和文件格式。",
    "2. 根据姓名、工作日期和工作内容补全模板；不得虚构未提供的事实。",
    "3. 对工作内容进行清晰、专业的归纳整理，并生成完整成品文件。",
    "4. 将成品文件写入本计划任务配置的本地输出目录；文件扩展名应与模板一致。",
    "5. 最终回复中说明生成的文件名和保存位置。",
    ...excelRequirements,
  ].join("\n");
}
