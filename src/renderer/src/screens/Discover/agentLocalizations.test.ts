import { describe, expect, it } from "vitest";
import type { RegistryItem } from "../../../../shared/registry";
import { AGENT_ZH_CN, localizeRegistryAgent } from "./agentLocalizations";

describe("Agent Chinese presentation copy", () => {
  it("covers the current 17 Registry Agents without replacing identity fields", () => {
    // @lat: [[discover#Agent Chinese presentation]]
    expect(Object.keys(AGENT_ZH_CN)).toHaveLength(17);
    const source: RegistryItem = {
      id: "incident-responder",
      name: "Incident Responder",
      description: "Triages production incidents.",
      path: "agents/incident-responder",
    };

    expect(localizeRegistryAgent(source)).toEqual({
      ...source,
      displayName: "故障应急专家",
      displayAuthor: "旌渝",
      displayDescription: "处理生产故障、恢复服务并开展无责复盘。",
    });
  });

  it("keeps future Agent copy while applying the company provider label", () => {
    const source: RegistryItem = {
      id: "future-agent",
      name: "Future Agent",
      description: "Added by the upstream Registry later.",
    };
    expect(localizeRegistryAgent(source)).toEqual({
      ...source,
      displayAuthor: "旌渝",
    });
  });
});
