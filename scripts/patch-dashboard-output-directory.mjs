/* eslint-disable @typescript-eslint/explicit-function-return-type -- build-time Python source transforms. */

function normalize(source) {
  return source.replace(/\r\n/g, "\n");
}

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    throw new Error(`Dashboard output-directory marker not found: ${label}`);
  }
  // Template literals below mirror unified diffs for readability. Strip their
  // visual addition markers before writing the transformed Python source.
  return source.replace(before, after.replace(/\n\+/g, "\n"));
}

/** Teach prompt.submit to validate and snapshot the Desktop-provided output_dir. */
export function patchDashboardOutputDirectoryPromptSource(source) {
  let patched = normalize(source);
  if (patched.includes("HERMES_DESKTOP_OUTPUT_DIR_PROMPT")) return patched;

  patched = replaceRequired(
    patched,
    `    text = sanitize_user_prompt_text(raw_text) if isinstance(raw_text, str) else raw_text\n`,
    `    text = sanitize_user_prompt_text(raw_text) if isinstance(raw_text, str) else raw_text\n+    # HERMES_DESKTOP_OUTPUT_DIR_PROMPT: validate once and keep this turn's snapshot.\n+    output_dir, output_dir_error = _normalize_desktop_output_dir(params.get("output_dir"))\n+    if output_dir_error:\n+        return _err(rid, 4004, output_dir_error)\n`,
    "prompt parse",
  );
  patched = replaceRequired(
    patched,
    `            queued=bool(params.get("queued")),\n`,
    `            queued=bool(params.get("queued")),\n+            output_dir=output_dir,\n`,
    "busy snapshot",
  );
  patched = replaceRequired(
    patched,
    `        isolated_response = _submit_prompt_to_compute_host(rid, sid, session, text)\n`,
    `        isolated_response = _submit_prompt_to_compute_host(\n+            rid, sid, session, text, output_dir=output_dir\n+        )\n`,
    "compute-host dispatch",
  );
  patched = replaceRequired(
    patched,
    `        _run_prompt_submit(rid, sid, session, text)\n`,
    `        _run_prompt_submit(rid, sid, session, text, output_dir=output_dir)\n`,
    "inline dispatch",
  );
  return patched;
}

/** Carry output_dir through queues/compute hosts and apply it ephemerally per turn. */
export function patchDashboardOutputDirectoryServerSource(source) {
  let patched = normalize(source);
  if (patched.includes("HERMES_DESKTOP_OUTPUT_DIR_SERVER")) return patched;

  patched = replaceRequired(
    patched,
    `def _compute_host_turn_frame(\n`,
    `# HERMES_DESKTOP_OUTPUT_DIR_SERVER: local, turn-scoped deliverable destination.\n+def _normalize_desktop_output_dir(value: Any) -> tuple[str | None, str | None]:\n+    if value is None or value == "":\n+        return None, None\n+    if not isinstance(value, str):\n+        return None, "output_dir must be an absolute directory path"\n+    candidate = Path(value.strip()).expanduser()\n+    if not candidate.is_absolute():\n+        return None, "output_dir must be an absolute directory path"\n+    try:\n+        resolved = candidate.resolve(strict=True)\n+    except (OSError, RuntimeError):\n+        return None, f"output_dir does not exist: {candidate}"\n+    if not resolved.is_dir():\n+        return None, f"output_dir is not a directory: {resolved}"\n+    return str(resolved), None\n+\n+\n+def _desktop_output_system_prompt(output_dir: str) -> str:\n+    return (\n+        "Save every newly generated user deliverable for this turn in the "\n+        f"following directory: {output_dir}. Use an absolute path directly "\n+        "under that directory unless the user explicitly requests another "\n+        "location. Do not use the working directory, a recently seen folder, "\n+        "or a guessed subdirectory as the deliverable destination. Existing "\n+        "source files remain edited in place; caches and temporary files stay "\n+        "in their managed temporary directories."\n+    )\n+\n+\n+def _compute_host_turn_frame(\n`,
    "server helpers",
  );
  patched = replaceRequired(
    patched,
    `    image_paths: list[str] | None = None,\n    queued_prompt_generation: int | None = None,\n) -> dict:\n`,
    `    image_paths: list[str] | None = None,\n    queued_prompt_generation: int | None = None,\n    output_dir: str | None = None,\n) -> dict:\n`,
    "compute frame signature",
  );
  patched = replaceRequired(
    patched,
    `        "queued_prompt_generation": queued_prompt_generation,\n`,
    `        "queued_prompt_generation": queued_prompt_generation,\n+        "output_dir": output_dir,\n`,
    "compute frame payload",
  );
  patched = replaceRequired(
    patched,
    `def _submit_prompt_to_compute_host(\n    rid: str,\n    sid: str,\n    session: dict,\n    text: Any,\n    image_paths: list[str] | None = None,\n    queued_prompt_generation: int | None = None,\n) -> dict:\n`,
    `def _submit_prompt_to_compute_host(\n    rid: str,\n    sid: str,\n    session: dict,\n    text: Any,\n    image_paths: list[str] | None = None,\n    queued_prompt_generation: int | None = None,\n    output_dir: str | None = None,\n) -> dict:\n`,
    "compute submit signature",
  );
  patched = replaceRequired(
    patched,
    `        queued_prompt_generation=queued_prompt_generation,\n    )\n\n    def _complete(done: dict) -> None:\n`,
    `        queued_prompt_generation=queued_prompt_generation,\n+        output_dir=output_dir,\n+    )\n+\n+    def _complete(done: dict) -> None:\n`,
    "compute submit payload",
  );
  patched = replaceRequired(
    patched,
    `def _enqueue_prompt(\n    session: dict,\n    text: Any,\n    transport: Any,\n    image_paths: list[str] | None = None,\n) -> None:\n`,
    `def _enqueue_prompt(\n    session: dict,\n    text: Any,\n    transport: Any,\n    image_paths: list[str] | None = None,\n    output_dir: str | None = None,\n) -> None:\n`,
    "queue signature",
  );
  patched = replaceRequired(
    patched,
    `    queued = {"text": text, "transport": transport}\n`,
    `    queued = {"text": text, "transport": transport, "output_dir": output_dir}\n`,
    "queue envelope",
  );
  patched = replaceRequired(
    patched,
    `        and not session.get("queued_prompts")\n`,
    `        and not session.get("queued_prompts")\n+        and existing.get("output_dir") == output_dir\n`,
    "queue merge guard",
  );
  patched = replaceRequired(
    patched,
    `def _handle_busy_submit(\n    rid, sid: str, session: dict, text: Any, transport: Any, queued: bool = False\n) -> dict | None:\n`,
    `def _handle_busy_submit(\n    rid, sid: str, session: dict, text: Any, transport: Any, queued: bool = False,\n    output_dir: str | None = None,\n) -> dict | None:\n`,
    "busy signature",
  );
  patched = replaceRequired(
    patched,
    `        _enqueue_prompt(session, text, transport, image_paths=image_paths)\n`,
    `        _enqueue_prompt(\n+            session, text, transport, image_paths=image_paths, output_dir=output_dir\n+        )\n`,
    "busy enqueue",
  );

  const queuedCallAnchors = [
    [
      `                resp = _submit_prompt_to_compute_host(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    image_paths=queued["image_paths"],\n                    queued_prompt_generation=queue_generation,\n                )\n`,
      `                resp = _submit_prompt_to_compute_host(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    image_paths=queued["image_paths"],\n                    queued_prompt_generation=queue_generation,\n+                    output_dir=queued.get("output_dir"),\n+                )\n`,
    ],
    [
      `                resp = _submit_prompt_to_compute_host(\n                    rid, sid, session, queued["text"], queued_prompt_generation=queue_generation\n                )\n`,
      `                resp = _submit_prompt_to_compute_host(\n                    rid, sid, session, queued["text"],\n+                    queued_prompt_generation=queue_generation,\n+                    output_dir=queued.get("output_dir"),\n+                )\n`,
    ],
    [
      `                _run_prompt_submit(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    image_paths=queued["image_paths"],\n                    queued_prompt_generation=queue_generation,\n                )\n`,
      `                _run_prompt_submit(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    image_paths=queued["image_paths"],\n                    queued_prompt_generation=queue_generation,\n+                    output_dir=queued.get("output_dir"),\n+                )\n`,
    ],
    [
      `                _run_prompt_submit(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    queued_prompt_generation=queue_generation,\n                )\n`,
      `                _run_prompt_submit(\n                    rid,\n                    sid,\n                    session,\n                    queued["text"],\n                    queued_prompt_generation=queue_generation,\n+                    output_dir=queued.get("output_dir"),\n+                )\n`,
    ],
  ];
  for (let index = 0; index < queuedCallAnchors.length; index += 1) {
    const [before, after] = queuedCallAnchors[index];
    patched = replaceRequired(
      patched,
      before,
      after,
      `queued dispatch ${index + 1}`,
    );
  }

  patched = replaceRequired(
    patched,
    `def _run_prompt_submit(\n    rid,\n    sid: str,\n    session: dict,\n    text: Any,\n    *,\n`,
    `def _run_prompt_submit(\n    rid,\n    sid: str,\n    session: dict,\n    text: Any,\n    *,\n    output_dir: str | None = None,\n`,
    "turn signature",
  );
  patched = replaceRequired(
    patched,
    `        turn_error_retained = False\n`,
    `        turn_error_retained = False\n+        previous_ephemeral_system_prompt = None\n+        output_policy_applied = False\n`,
    "turn state",
  );
  patched = replaceRequired(
    patched,
    `            run_kwargs = {\n`,
    `            if output_dir:\n+                previous_ephemeral_system_prompt = getattr(\n+                    agent, "ephemeral_system_prompt", None\n+                )\n+                output_policy = _desktop_output_system_prompt(output_dir)\n+                agent.ephemeral_system_prompt = (\n+                    f"{previous_ephemeral_system_prompt}\\n\\n{output_policy}".strip()\n+                    if previous_ephemeral_system_prompt\n+                    else output_policy\n+                )\n+                output_policy_applied = True\n+\n+            run_kwargs = {\n`,
    "ephemeral policy",
  );
  patched = replaceRequired(
    patched,
    `            # Drop both local snapshots of the pre-turn history before asking\n`,
    `            if output_policy_applied:\n+                agent.ephemeral_system_prompt = previous_ephemeral_system_prompt\n+\n+            # Drop both local snapshots of the pre-turn history before asking\n`,
    "ephemeral restore",
  );
  patched = replaceRequired(
    patched,
    `                _enqueue_prompt(session, _leftover_steer, session.get("transport"))\n`,
    `                _enqueue_prompt(\n+                    session, _leftover_steer, session.get("transport"), output_dir=output_dir\n+                )\n`,
    "leftover steer",
  );
  patched = replaceRequired(
    patched,
    `                _run_prompt_submit(rid, sid, session, goal_followup)\n`,
    `                _run_prompt_submit(\n+                    rid, sid, session, goal_followup, output_dir=output_dir\n+                )\n`,
    "goal continuation",
  );
  return patched;
}

/** Pass the parent process's turn-scoped directory into an isolated compute host. */
export function patchDashboardOutputDirectoryComputeHostSource(source) {
  const normalized = normalize(source);
  if (normalized.includes('output_dir=frame.get("output_dir")')) {
    return normalized;
  }
  return replaceRequired(
    normalized,
    `            server._run_prompt_submit(request_id, sid, session, text)\n`,
    `            server._run_prompt_submit(\n+                request_id, sid, session, text,\n+                output_dir=frame.get("output_dir"),\n+            )\n`,
    "compute child dispatch",
  );
}
