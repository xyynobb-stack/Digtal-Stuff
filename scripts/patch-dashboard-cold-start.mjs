/**
 * Keep the Desktop dashboard's liveness path independent from the full
 * messaging-gateway import. The embedded `/api/ws` endpoint imports its own
 * chat runtime on first connection, so eagerly importing hermes_cli.gateway
 * before Uvicorn binds only delays health checks and duplicates unrelated
 * platform-adapter work.
 * @param {string} source Upstream `hermes_cli/web_server.py` source.
 * @returns {string} Source with desktop-only lazy messaging-gateway warm-up.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function patchDashboardColdStartSource(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (
    normalized.includes(
      "Desktop liveness must not wait for the full messaging gateway",
    )
  ) {
    return normalized;
  }

  const anchor = `    # Import hermes_cli.gateway eagerly *before* the lifespan yield so the
    # GIL-heavy .pyc compilation and Defender scan cost is absorbed during
    # backend initialisation \u2014 before the server socket accepts probes.
    # On Windows + Python 3.11 the import does not release the GIL, so
    # run_in_executor still froze the event loop for 15-22 s, causing the
    # Desktop's 10-second WebSocket ready-probe to time out (GH-73083).
    _warm_gateway_module()`;
  const replacement = `    # Desktop liveness must not wait for the full messaging gateway. The
    # desktop uses the embedded tui_gateway /api/ws runtime, not the messaging
    # platform adapters imported by hermes_cli.gateway. On cold Windows hosts
    # that unrelated import performs .pyc compilation and Defender scans for
    # 15-30 seconds before Uvicorn can bind. Non-desktop dashboard launches
    # retain the upstream eager warm-up behaviour.
    if os.getenv("HERMES_DESKTOP") != "1":
        _warm_gateway_module()`;

  if (!normalized.includes(anchor)) {
    throw new Error("Dashboard cold-start warm-up marker was not found");
  }
  return normalized.replace(anchor, replacement);
}
