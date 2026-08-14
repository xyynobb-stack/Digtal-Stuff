import { createHash } from "crypto";

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

/**
 * Stable, filesystem-safe directory name for one immutable packaged runtime.
 * The desktop version keeps folders recognizable; the digest prevents two
 * runtime snapshots published under the same version from sharing a tree.
 */
export function desktopRuntimeVersionName(
  packagedMarker: string,
  desktopVersion: string,
): string {
  const version = (desktopVersion.trim() || "unknown").replace(
    /[^a-zA-Z0-9._-]+/g,
    "-",
  );
  const digest = createHash("sha256")
    .update(desktopRuntimeBuildIdentity(packagedMarker, desktopVersion))
    .digest("hex")
    .slice(0, 16);
  return `${version}-${digest}`;
}
