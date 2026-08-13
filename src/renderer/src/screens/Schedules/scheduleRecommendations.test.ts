import { describe, expect, it } from "vitest";
import {
  buildReportRecommendationPrompt,
  compareDateParts,
  datePartsToIso,
  daysInMonth,
  requiredSkillsForTemplate,
} from "./scheduleRecommendations";

const template = {
  id: "weekly-xlsx",
  name: "周报表格",
  fileName: "周报表格.xlsx",
  extension: "xlsx",
  mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size: 128,
  createdAt: "2026-08-13T00:00:00.000Z",
  path: "C:\\templates\\周报表格.xlsx",
};

describe("schedule report recommendations", () => {
  it("formats and compares dropdown date values", () => {
    expect(datePartsToIso({ year: 2026, month: 8, day: 3 })).toBe("2026-08-03");
    expect(
      compareDateParts(
        { year: 2026, month: 8, day: 10 },
        { year: 2026, month: 8, day: 9 },
      ),
    ).toBeGreaterThan(0);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it("builds a weekly task prompt with its template and date range", () => {
    const prompt = buildReportRecommendationPrompt({
      type: "weekly-report",
      employeeName: "张三",
      workContent: "完成合同审查并跟进客户反馈。",
      startDate: { year: 2026, month: 8, day: 10 },
      endDate: { year: 2026, month: 8, day: 16 },
      template,
    });

    expect(prompt).toContain("周报汇总");
    expect(prompt).toContain("2026-08-10 至 2026-08-16");
    expect(prompt).toContain("C:\\templates\\周报表格.xlsx");
    expect(prompt).toContain("完成合同审查并跟进客户反馈");
    expect(prompt).toContain("文件扩展名应与模板一致");
    expect(prompt).toContain("Use the activated xlsx skill");
    expect(prompt).toContain("copy the original Excel template");
    expect(prompt).toContain(
      "Do not create or output a Word/DOC/DOCX document",
    );
    expect(requiredSkillsForTemplate(template)).toEqual(["xlsx"]);
  });

  it("does not attach the xlsx skill to a Word template", () => {
    expect(
      requiredSkillsForTemplate({ ...template, extension: "docx" }),
    ).toBeUndefined();
  });
});
