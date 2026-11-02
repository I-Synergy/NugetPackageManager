/**
 * Presentation helpers for NuGet packages, shared by every webview tab.
 *
 * These live in src/common because both bundles may use them, so nothing here
 * may import Node.js built-ins.
 */

/**
 * Formats a download count the way the package rows and details panes show it.
 *
 * The sidecar omits nulls from the JSON (JsonIgnoreCondition.WhenWritingNull),
 * so an unknown count arrives as `undefined` as well as `null`; both render as
 * an em dash, never as `0`.
 */
export function FormatDownloads(count: number | null | undefined): string {
  if (count == null) return "—";
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

/** SemVer prerelease detection used by the version badges and filters. */
export function IsPrereleaseVersion(version: string): boolean {
  return version.includes("-");
}
