import { describe, expect, it } from "vitest";
import {
  compileExperience,
  emptyExperience,
  emptyScenario,
  SCENARIO_FIELDS,
  validateExperience,
} from "./experience-skill";

export function exampleTemplate() {
  const scene = emptyScenario();
  for (const [key] of SCENARIO_FIELDS) scene[key] = `公司特有内容-${key}`;
  scene.steps = "先向技术部经理核实工时\n再交客户书面确认\n确认后更新排期";
  return { role: "项目经理", scope: "仅本团队", scenarios: [scene] };
}
describe("experience compiler", () => {
  it("retains every source field, ordered steps and scenario provenance", () => {
    const template = exampleTemplate();
    const result = compileExperience(template, "向永驿");
    expect(result).toContain('display_name: "向永驿的SKILL"');
    for (const [key] of SCENARIO_FIELDS)
      for (const line of template.scenarios[0][key].split("\n"))
        expect(result).toContain(`> ${line}`);
    expect(result.indexOf("先向技术部经理")).toBeLessThan(
      result.indexOf("再交客户"),
    );
    expect(result).toContain("来源：填写模板 → 场景 1 → 具体工作步骤");
  });
  it("rejects incomplete and oversized questionnaires", () => {
    expect(() => validateExperience(emptyExperience())).toThrow();
    expect(() =>
      validateExperience({ ...exampleTemplate(), role: "x".repeat(6001) }),
    ).toThrow();
    expect(() =>
      validateExperience({ ...exampleTemplate(), scenarios: [null] }),
    ).toThrow();
  });
  it("keeps distinct scenes separate and quotes embedded control text", () => {
    const template = exampleTemplate();
    template.scenarios.push({
      ...emptyScenario(),
      ...template.scenarios[0],
      title: "验收",
      steps: "---\n# 不可信标题",
    });
    const result = compileExperience(template, "向永驿");
    expect(result).toContain("### S2 工作流程");
    expect(result).toContain("> ---\n> # 不可信标题");
    expect(result).toContain("多个场景同时命中时先澄清主场景");
  });
});
