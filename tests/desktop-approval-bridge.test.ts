import { describe, expect, it } from "vitest";
import {
  patchApprovalApiServerSource,
  patchApprovalCoreSource,
  patchApprovalPromptSource,
} from "../scripts/patch-desktop-approval-bridge.mjs";

describe("Desktop approval bridge overlay", () => {
  it("assigns identities and resolves the exact blocked request", () => {
    const fixture = `import unicodedata

class _ApprovalEntry:
    __slots__ = ("event", "data", "result", "reason")

    def __init__(self, data: dict):
        self.event = threading.Event()

def resolve_gateway_approval(session_key: str, choice: str,
                             resolve_all: bool = False,
                             reason: Optional[str] = None) -> int:
        if resolve_all:
            targets = list(queue)
            queue.clear()
        else:
            targets = [queue.pop(0)]
`;

    const patched = patchApprovalCoreSource(fixture);
    expect(patched).toContain('data["request_id"] = self.request_id');
    expect(patched).toContain("elif request_id:");
    expect(patched).toContain("entry.request_id == request_id");
    expect(patchApprovalCoreSource(patched)).toBe(patched);
  });

  it("forwards request_id through both runtime response endpoints", () => {
    const prompt = patchApprovalPromptSource(
      'resolve_gateway_approval(\n                    resolve_all=params.get("all", False),\n)\n',
    );
    const api = patchApprovalApiServerSource(`
async def _handle_run_approval():
    resolve_gateway_approval(
                resolve_all=resolve_all,
    )
`);

    expect(prompt).toContain('request_id=params.get("request_id")');
    expect(api).toContain('request_id=body.get("request_id")');
  });
});
