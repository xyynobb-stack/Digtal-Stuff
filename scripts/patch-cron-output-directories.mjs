import fs from "node:fs";
import path from "node:path";

function replaceRequired(source, search, replacement, filePath) {
  if (!source.includes(search)) {
    throw new Error(`Cron output-directory patch marker not found: ${filePath}`);
  }
  return source.replace(search, replacement);
}

function patchFile(agentRoot, relativePath, marker, transform) {
  const filePath = path.join(agentRoot, ...relativePath.split("/"));
  let source = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  if (source.includes(marker)) return;
  source = transform(source, filePath);
  if (!source.includes(marker)) {
    throw new Error(`Cron output-directory patch failed: ${filePath}`);
  }
  fs.writeFileSync(filePath, source, "utf8");
}

export function patchCronOutputDirectories(agentRoot) {
  patchFile(agentRoot, "cron/jobs.py", "def _normalize_output_dir", (source, filePath) => {
    source = replaceRequired(
      source,
      `def _job_output_dir(job_id: str) -> Path:`,
      `def _job_output_dir(job_id: str, output_root: Optional[str] = None) -> Path:`,
      filePath,
    );
    source = replaceRequired(
      source,
      `    return _current_cron_store().output_dir / text\n\n\ndef _normalize_skill_list`,
      `    root = Path(output_root).expanduser() if output_root else _current_cron_store().output_dir\n    return root / text\n\n\ndef get_job_output_dir(job_id: str) -> Path:\n    \"\"\"Return the effective per-job output directory for reads and chaining.\"\"\"\n    job = get_job(job_id)\n    output_root = job.get(\"output_dir\") if job else None\n    return _job_output_dir(job_id, output_root)\n\n\ndef _normalize_skill_list`,
      filePath,
    );
    source = replaceRequired(
      source,
      `    return str(resolved)\n\n\ndef _resolve_default_model_snapshot`,
      `    return str(resolved)\n\n\ndef _normalize_output_dir(output_dir: Optional[str]) -> Optional[str]:\n    \"\"\"Normalize a user-selected root directory for this job's saved output.\"\"\"\n    if output_dir is None:\n        return None\n    raw = str(output_dir).strip()\n    if not raw:\n        return None\n    expanded = Path(raw).expanduser()\n    if not expanded.is_absolute():\n        raise ValueError(f\"Cron output directory must be an absolute path (got {raw!r}).\")\n    resolved = expanded.resolve()\n    if not resolved.exists():\n        raise ValueError(f\"Cron output directory does not exist: {resolved}\")\n    if not resolved.is_dir():\n        raise ValueError(f\"Cron output directory is not a directory: {resolved}\")\n    return str(resolved)\n\n\ndef _resolve_default_model_snapshot`,
      filePath,
    );
    source = replaceRequired(
      source,
      `    no_agent: bool = False,\n    attach_to_session: Optional[bool] = None,`,
      `    no_agent: bool = False,\n    attach_to_session: Optional[bool] = None,\n    output_dir: Optional[str] = None,`,
      filePath,
    );
    source = replaceRequired(
      source,
      `        no_agent: When True,`,
      `        output_dir: Optional absolute directory used as this job's output root.\n                    Run files remain isolated below a job-ID subdirectory. When\n                    unset, the active profile's \`cron/output\` root is used.\n        no_agent: When True,`,
      filePath,
    );
    source = replaceRequired(
      source,
      `    normalized_workdir = _normalize_workdir(workdir)\n    normalized_no_agent`,
      `    normalized_workdir = _normalize_workdir(workdir)\n    normalized_output_dir = _normalize_output_dir(output_dir)\n    normalized_no_agent`,
      filePath,
    );
    source = replaceRequired(
      source,
      `        \"workdir\": normalized_workdir,\n    }`,
      `        \"workdir\": normalized_workdir,\n        \"output_dir\": normalized_output_dir,\n    }`,
      filePath,
    );
    source = replaceRequired(
      source,
      `        save_job_output(job.get(\"id\", \"\"), text)`,
      `        save_job_output(job.get(\"id\", \"\"), text, job.get(\"output_dir\"))`,
      filePath,
    );
    source = replaceRequired(
      source,
      `def save_job_output(job_id: str, output: str):`,
      `def save_job_output(job_id: str, output: str, output_root: Optional[str] = None):`,
      filePath,
    );
    return replaceRequired(
      source,
      `    job_output_dir = _job_output_dir(job_id)`,
      `    job_output_dir = _job_output_dir(job_id, output_root)`,
      filePath,
    );
  });

  patchFile(agentRoot, "cron/scheduler.py", "get_job_output_dir(source_job_id)", (source, filePath) => {
    source = replaceRequired(
      source,
      `        from cron.jobs import get_cron_output_dir\n        output_dir = get_cron_output_dir()`,
      `        from cron.jobs import get_job_output_dir`,
      filePath,
    );
    source = replaceRequired(
      source,
      `                job_output_dir = output_dir / source_job_id`,
      `                job_output_dir = get_job_output_dir(source_job_id)`,
      filePath,
    );
    return replaceRequired(
      source,
      `            output_file = save_job_output(job[\"id\"], output)`,
      `            output_file = save_job_output(job[\"id\"], output, job.get(\"output_dir\"))`,
      filePath,
    );
  });

  patchFile(agentRoot, "hermes_cli/subcommands/cron.py", "--output-dir", (source, filePath) =>
    replaceRequired(
      source,
      `    cron_create.add_argument(\n        \"--model\",`,
      `    cron_create.add_argument(\n        \"--output-dir\",\n        help=\"Absolute root directory for this job's saved output. Omit to use the profile cron/output directory.\",\n    )\n    cron_create.add_argument(\n        \"--model\",`,
      filePath,
    ),
  );

  patchFile(agentRoot, "hermes_cli/cron.py", 'print(f"    Output dir:', (source, filePath) => {
    source = replaceRequired(
      source,
      `        if workdir:\n            print(f\"    Workdir:   {workdir}\")\n\n        # Execution history`,
      `        if workdir:\n            print(f\"    Workdir:   {workdir}\")\n        output_dir = job.get(\"output_dir\")\n        if output_dir:\n            print(f\"    Output dir: {output_dir}\")\n\n        # Execution history`,
      filePath,
    );
    source = replaceRequired(
      source,
      `        workdir=getattr(args, \"workdir\", None),\n        model=`,
      `        workdir=getattr(args, \"workdir\", None),\n        output_dir=getattr(args, \"output_dir\", None),\n        model=`,
      filePath,
    );
    return replaceRequired(
      source,
      `    if job_data.get(\"workdir\"):\n        print(f\"  Workdir: {job_data['workdir']}\")\n    print(f\"  Next run:`,
      `    if job_data.get(\"workdir\"):\n        print(f\"  Workdir: {job_data['workdir']}\")\n    if job_data.get(\"output_dir\"):\n        print(f\"  Output dir: {job_data['output_dir']}\")\n    print(f\"  Next run:`,
      filePath,
    );
  });

  patchFile(agentRoot, "tools/cronjob_tools.py", '"output_dir": job.get("output_dir")', (source, filePath) => {
    source = replaceRequired(
      source,
      `        "deliver": job.get("deliver", "local"),\n        "next_run_at": job.get("next_run_at"),`,
      `        "deliver": job.get("deliver", "local"),\n        "output_dir": job.get("output_dir"),\n        "next_run_at": job.get("next_run_at"),`,
      filePath,
    );
    source = replaceRequired(
      source,
      `    attach_to_session: Optional[bool] = None,\n    task_id: str = None,`,
      `    attach_to_session: Optional[bool] = None,\n    output_dir: Optional[str] = None,\n    task_id: str = None,`,
      filePath,
    );
    return replaceRequired(
      source,
      `                no_agent=_no_agent,\n                attach_to_session=attach_to_session,\n            )`,
      `                no_agent=_no_agent,\n                attach_to_session=attach_to_session,\n                output_dir=_normalize_optional_job_value(output_dir),\n            )`,
      filePath,
    );
  });

  patchFile(agentRoot, "hermes_cli/web_models.py", "output_dir: Optional[str]", (source, filePath) =>
    replaceRequired(
      source,
      `    workdir: Optional[str] = None\n    no_agent: bool = False`,
      `    workdir: Optional[str] = None\n    output_dir: Optional[str] = None\n    no_agent: bool = False`,
      filePath,
    ),
  );

  patchFile(agentRoot, "hermes_cli/web_server.py", "output_dir=_cron_optional_text(body.output_dir)", (source, filePath) =>
    replaceRequired(
      source,
      `            workdir=_cron_optional_text(body.workdir),\n            no_agent=no_agent,`,
      `            workdir=_cron_optional_text(body.workdir),\n            output_dir=_cron_optional_text(body.output_dir),\n            no_agent=no_agent,`,
      filePath,
    ),
  );

  patchFile(agentRoot, "gateway/platforms/api_server.py", 'output_dir = body.get("output_dir")', (source, filePath) => {
    source = replaceRequired(
      source,
      `            repeat = body.get(\"repeat\")`,
      `            repeat = body.get(\"repeat\")\n            output_dir = body.get(\"output_dir\")`,
      filePath,
    );
    return replaceRequired(
      source,
      `            if repeat is not None:\n                kwargs[\"repeat\"] = repeat\n\n            job = _cron_create`,
      `            if repeat is not None:\n                kwargs[\"repeat\"] = repeat\n            if output_dir:\n                kwargs[\"output_dir\"] = output_dir\n\n            job = _cron_create`,
      filePath,
    );
  });
}
