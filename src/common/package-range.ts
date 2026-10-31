/**
 * NuGet version-range helpers shared by the host and the webview.
 *
 * The webview needs the lower bound of a required range to offer the exact
 * version a conflicting update asks for, so the parser lives in `common/`.
 */

/** Lowest version a NuGet range can resolve to. */
export function RangeLowerBound(range: string): string | null {
  const trimmed = range.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[") || trimmed.startsWith("(")) {
    const closedEnd = trimmed.endsWith("]") || trimmed.endsWith(")");
    const inner = closedEnd ? trimmed.slice(1, -1) : trimmed.slice(1);
    const [first] = inner.split(",");
    const candidate = first?.trim();
    return candidate ? candidate : null;
  }

  // `>= 1.2.3` / `> 1.2.3` / `1.2.3`: the version is the minimum.
  const comparison = trimmed.replace(/^>=?\s*/, "");
  return /^\d/.test(comparison) ? comparison : null;
}
