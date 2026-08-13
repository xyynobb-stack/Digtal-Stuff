/**
 * Build the identity stored beside the writable packaged runtime.
 *
 * The staging marker identifies the Agent snapshot, while the desktop version
 * guarantees an application upgrade refreshes the managed userData copy even
 * when a release workflow accidentally reuses an older staging marker.
 */
export function desktopRuntimeBuildIdentity(
  packagedMarker: string,
  desktopVersion: string,
): string {
  const raw = packagedMarker.trim();
  let runtimeBuild: unknown = raw;
  if (raw) {
    try {
      runtimeBuild = JSON.parse(raw);
    } catch {
      // Preserve legacy/non-JSON markers as an opaque identity.
    }
  }

  return `${JSON.stringify(
    {
      desktopVersion: desktopVersion.trim() || "unknown",
      runtimeBuild,
    },
    null,
    2,
  )}\n`;
}
