// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildSessionSkillEnvelope,
  addAttachmentRefsToSessionEnvelope,
  unwrapSessionSkillEnvelope,
} from "./sessionSkillEnvelope";

describe("session skill transport envelope", () => {
  it("round-trips the user-authored message with selected skills", () => {
    const envelope = buildSessionSkillEnvelope("你好", [
      "python-web-reader",
      "pdf",
    ]);

    expect(envelope).toContain(
      "[Active session skills: python-web-reader, pdf]",
    );
    expect(envelope).toContain("Built-in skills are always available");
    expect(envelope).toContain("only user-added custom skills enabled");
    expect(unwrapSessionSkillEnvelope(envelope)).toBe("你好");
  });

  it("round-trips an empty selection without exposing the control text", () => {
    const envelope = buildSessionSkillEnvelope("你是什么模型", []);

    expect(unwrapSessionSkillEnvelope(envelope)).toBe("你是什么模型");
  });

  it("leaves ordinary user text unchanged", () => {
    const text = "[Active session skills: ] 只是我写的一句话";
    expect(unwrapSessionSkillEnvelope(text)).toBe(text);
  });

  it("keeps template instructions and attachment refs private", () => {
    const envelope = buildSessionSkillEnvelope("按模板写一份报告", [], {
      fileName: "报告模板.docx",
    });
    const withRef = addAttachmentRefsToSessionEnvelope(envelope, [
      "[File: 报告模板.docx](/uploads/report.docx)",
    ]);

    expect(withRef).toContain("[Active writing template: 报告模板.docx]");
    expect(withRef).toContain("[Attached files]");
    expect(unwrapSessionSkillEnvelope(withRef)).toBe("按模板写一份报告");
  });
});
