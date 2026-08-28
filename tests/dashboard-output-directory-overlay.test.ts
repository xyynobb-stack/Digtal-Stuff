import { describe, expect, it } from "vitest";
import {
  patchDashboardOutputDirectoryComputeHostSource,
  patchDashboardOutputDirectoryPromptSource,
  patchDashboardOutputDirectoryServerSource,
} from "../scripts/patch-dashboard-output-directory.mjs";

const serverFixture = `
def _compute_host_turn_frame(
    image_paths: list[str] | None = None,
    queued_prompt_generation: int | None = None,
) -> dict:
    return {
        "queued_prompt_generation": queued_prompt_generation,
    }

def _submit_prompt_to_compute_host(
    rid: str,
    sid: str,
    session: dict,
    text: Any,
    image_paths: list[str] | None = None,
    queued_prompt_generation: int | None = None,
) -> dict:
    frame = _compute_host_turn_frame(
        queued_prompt_generation=queued_prompt_generation,
    )

    def _complete(done: dict) -> None:
        pass

def _enqueue_prompt(
    session: dict,
    text: Any,
    transport: Any,
    image_paths: list[str] | None = None,
) -> None:
    queued = {"text": text, "transport": transport}
    if (
        existing
        and not session.get("queued_prompts")
    ):
        pass

def _handle_busy_submit(
    rid, sid: str, session: dict, text: Any, transport: Any, queued: bool = False
) -> dict | None:
    if queued:
        _enqueue_prompt(session, text, transport, image_paths=image_paths)

def drain():
    if active:
        if use_compute_host:
            if queued.get("image_paths"):
                resp = _submit_prompt_to_compute_host(
                    rid,
                    sid,
                    session,
                    queued["text"],
                    image_paths=queued["image_paths"],
                    queued_prompt_generation=queue_generation,
                )
            else:
                resp = _submit_prompt_to_compute_host(
                    rid, sid, session, queued["text"], queued_prompt_generation=queue_generation
                )
        else:
            if queued.get("image_paths"):
                _run_prompt_submit(
                    rid,
                    sid,
                    session,
                    queued["text"],
                    image_paths=queued["image_paths"],
                    queued_prompt_generation=queue_generation,
                )
            else:
                _run_prompt_submit(
                    rid,
                    sid,
                    session,
                    queued["text"],
                    queued_prompt_generation=queue_generation,
                )

def _run_prompt_submit(
    rid,
    sid: str,
    session: dict,
    text: Any,
    *,
) -> None:
    def run():
        turn_error_retained = False
        try:
            run_kwargs = {
                "conversation_history": [],
            }
        finally:
            # Drop both local snapshots of the pre-turn history before asking
            pass
        if leftover:
                _enqueue_prompt(session, _leftover_steer, session.get("transport"))
        if goal_followup:
                _run_prompt_submit(rid, sid, session, goal_followup)
`;

describe("Dashboard output-directory overlay", () => {
  // @lat: [[context-folder#Output destination]]
  it("keeps a validated destination isolated to each queued or active turn", () => {
    const patched = patchDashboardOutputDirectoryServerSource(serverFixture);

    expect(patched).toContain("candidate.resolve(strict=True)");
    expect(patched).toContain('existing.get("output_dir") == output_dir');
    expect(
      patched.match(/output_dir=queued\.get\("output_dir"\)/g),
    ).toHaveLength(4);
    expect(patched).toContain("agent.ephemeral_system_prompt = (");
    expect(patched).toContain(
      "agent.ephemeral_system_prompt = previous_ephemeral_system_prompt",
    );
    expect(patched).not.toMatch(/^\+/m);
    expect(patchDashboardOutputDirectoryServerSource(patched)).toBe(patched);
  });

  it("accepts output_dir at the RPC boundary and forwards it to compute hosts", () => {
    const promptFixture = `
    text = sanitize_user_prompt_text(raw_text) if isinstance(raw_text, str) else raw_text
        busy = _handle_busy_submit(
            queued=bool(params.get("queued")),
        )
        isolated_response = _submit_prompt_to_compute_host(rid, sid, session, text)
        _run_prompt_submit(rid, sid, session, text)
`;
    const computeFixture =
      "            server._run_prompt_submit(request_id, sid, session, text)\n";

    const prompt = patchDashboardOutputDirectoryPromptSource(promptFixture);
    const compute =
      patchDashboardOutputDirectoryComputeHostSource(computeFixture);

    expect(prompt).toContain('params.get("output_dir")');
    expect(prompt).toContain("output_dir=output_dir");
    expect(compute).toContain('output_dir=frame.get("output_dir")');
    expect(prompt).not.toMatch(/^\+/m);
    expect(compute).not.toMatch(/^\+/m);
  });

  it("preserves a newer Agent runtime that already supports output_dir", () => {
    const nativeServer = `
def _validate_output_directory(raw):
    return raw

def _enrich_with_output_directory(message, output_dir):
    return message

def frame(output_dir):
    return {"output_dir": output_dir}

def drain(queued):
    return run(output_dir=queued.get("output_dir"))

def submit(run_message, output_dir):
    return _enrich_with_output_directory(run_message, output_dir)
`;
    const nativePrompt = `
output_dir = _validate_output_directory(params.get("output_dir"))
submit(output_dir=output_dir)
`;
    const nativeCompute = `
server._run_prompt_submit(
    request_id,
    sid,
    session,
    text,
    display_text=frame.get("display_text"),
    output_dir=frame.get("output_dir"),
)
`;

    expect(patchDashboardOutputDirectoryServerSource(nativeServer)).toBe(
      nativeServer,
    );
    expect(patchDashboardOutputDirectoryPromptSource(nativePrompt)).toBe(
      nativePrompt,
    );
    expect(patchDashboardOutputDirectoryComputeHostSource(nativeCompute)).toBe(
      nativeCompute,
    );
  });
});
