/* eslint-disable @typescript-eslint/explicit-function-return-type -- Plain Node ESM build helper. */
import fs from "node:fs";
import path from "node:path";

const helper = new URL(
  "../resources/hermes-agent-overlays/gateway/desktop_startup_diag.py",
  import.meta.url,
);

export function patchGatewayStartupSource(source, kind) {
  if (source.includes("# desktop-startup-diagnostics-v1")) return source;
  const edits =
    kind === "cli"
      ? [
          [
            "    from gateway.run import start_gateway",
            "    from gateway import desktop_startup_diag as _startup_diag\n    _startup_diag.begin()\n    from gateway.run import start_gateway\n    _startup_diag.phase('gateway_module_import.end')",
          ],
          [
            "        success = asyncio.run(start_gateway(replace=replace, verbosity=verbosity))",
            "        _startup_diag.phase('start_gateway.begin')\n        success = asyncio.run(start_gateway(replace=replace, verbosity=verbosity))\n        _startup_diag.phase('start_gateway.returned')",
          ],
        ]
      : kind === "api"
        ? [
            [
              '                "[%s] API server listening on http://%s:%d (model: %s)",',
              '                "[%s] API server listening on http://%s:%d (model: %s)",',
            ],
            [
              "            self._mark_connected()",
              "            self._mark_connected()\n            from gateway import desktop_startup_diag as _startup_diag\n            _startup_diag.finish()",
            ],
          ]
        : [
            [
              "    record_boot_fingerprint()",
              "    from gateway import desktop_startup_diag as _startup_diag\n    _startup_diag.phase('fingerprint.begin')\n    record_boot_fingerprint()\n    _startup_diag.phase('fingerprint.end')",
            ],
            [
              "    existing_pid = get_running_pid()",
              "    _startup_diag.phase('existing_pid.begin')\n    existing_pid = get_running_pid()\n    _startup_diag.phase('existing_pid.end')",
            ],
            [
              "        sync_skills(quiet=True)",
              "        _startup_diag.phase('skills_sync.begin')\n        sync_skills(quiet=True)\n        _startup_diag.phase('skills_sync.end')",
            ],
            [
              '    setup_logging(hermes_home=_hermes_home, mode="gateway")',
              "    _startup_diag.phase('logging_setup.begin')\n    setup_logging(hermes_home=_hermes_home, mode=\"gateway\")\n    _startup_diag.phase('logging_setup.end')",
            ],
            [
              "    runner = GatewayRunner(config)",
              "    _startup_diag.phase('runner_init.begin')\n    runner = GatewayRunner(config)\n    _startup_diag.phase('runner_init.end')",
            ],
            [
              "    if not acquire_gateway_runtime_lock():",
              "    _startup_diag.phase('runtime_lock.begin')\n    if not acquire_gateway_runtime_lock():",
            ],
            [
              "        success = await runner.start()",
              "        _startup_diag.phase('runner_start.begin')\n        success = await runner.start()\n        _startup_diag.phase('runner_start.end')",
            ],
          ];
  for (const [from, to] of edits) {
    if (source.split(from).length !== 2)
      throw new Error(`Gateway diagnostic anchor mismatch: ${kind}: ${from}`);
    source = source.replace(from, to);
  }
  return source + "\n# desktop-startup-diagnostics-v1\n";
}

export function patchGatewayStartupDiagnostics(agentRoot) {
  const targets = [
    ["hermes_cli/gateway.py", "cli"],
    ["gateway/run.py", "run"],
    ["gateway/platforms/api_server.py", "api"],
  ];
  const changes = targets.map(([file, kind]) => {
    const target = path.join(agentRoot, file);
    return [
      target,
      patchGatewayStartupSource(fs.readFileSync(target, "utf8"), kind),
    ];
  });
  fs.copyFileSync(
    helper,
    path.join(agentRoot, "gateway/desktop_startup_diag.py"),
  );
  for (const [target, source] of changes) fs.writeFileSync(target, source);
}
