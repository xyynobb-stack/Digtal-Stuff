import { describe, expect, it } from "vitest";
import { patchCronDeliverableOutputSource } from "../scripts/patch-cron-output-directories.mjs";

const schedulerFixture = `
def _build_job_prompt(job: dict, prerun_script: Optional[tuple] = None) -> str:
    user_prompt = str(job.get("prompt") or "")
    prompt = user_prompt
    skills = job.get("skills")

def run_job(job):
        # Apply workdir if configured
        _job_workdir = (job.get("workdir") or "").strip() or None
    # internally). This avoids a separate import/set/clear dance (#69396).
    _job_workdir = (job.get("workdir") or "").strip() or None
`;

const malformedInstalledFixture = `
def _resolve_job_deliverable_output_dir(job: dict) -> Optional[str]:
    return str(job.get("output_dir") or "") or None

def _build_job_prompt(job: dict, prerun_script: Optional[tuple] = None) -> str:
    user_prompt = str(job.get("prompt") or "")
    prompt = user_prompt
    deliverable_output_dir = _resolve_job_deliverable_output_dir(job)
    skills = job.get("skills")

def run_job(job):
        # Apply workdir if configured
        _configured_workdir = (job.get("workdir") or "").strip() or None
    _job_workdir = _configured_workdir or _resolve_job_deliverable_output_dir(job)
        if _job_workdir:
            pass
    # internally). This avoids a separate import/set/clear dance (#69396).
    _job_workdir = (job.get("workdir") or "").strip() or None
`;

describe("Cron deliverable output-directory overlay", () => {
  // @lat: [[main-process#Local cron command execution#Generated deliverable destination]]
  it("injects the exact output path and uses it as the default tool workdir", () => {
    const patched = patchCronDeliverableOutputSource(schedulerFixture);

    expect(patched).toContain("candidate.resolve(strict=True)");
    expect(patched).toContain(
      'f"Save every newly generated user-facing deliverable in: {deliverable_output_dir}\\n"',
    );
    expect(patched).toContain(
      "_job_workdir = _configured_workdir or _resolve_job_deliverable_output_dir(job)",
    );
    expect(patchCronDeliverableOutputSource(patched)).toBe(patched);
  });

  it("repairs the malformed no-agent indentation produced for an older runtime", () => {
    const repaired = patchCronDeliverableOutputSource(
      malformedInstalledFixture,
    );

    expect(repaired).toContain(
      '        _job_workdir = (job.get("workdir") or "").strip() or None\n        if _job_workdir:',
    );
    expect(repaired).toContain(
      "    _job_workdir = _configured_workdir or _resolve_job_deliverable_output_dir(job)",
    );
    expect(patchCronDeliverableOutputSource(repaired)).toBe(repaired);
  });
});
