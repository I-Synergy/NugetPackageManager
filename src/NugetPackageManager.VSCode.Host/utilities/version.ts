/** NuGet SemVer comparison and version-range matching. */

type ParsedVersion = { release: string; prerelease: string };

function splitVersion(value: string): ParsedVersion {
  // Strip NuGet version range brackets/parentheses and build metadata (+...).
  const clean = value.replace(/[[\]()]/g, "").split("+")[0] ?? value;
  // NuGet follows SemVer: 1.0.0-beta is a prerelease of 1.0.0.
  const firstDash = clean.indexOf("-");
  if (firstDash < 0) return { release: clean, prerelease: "" };
  return {
    release: clean.substring(0, firstDash),
    prerelease: clean.substring(firstDash + 1),
  };
}

function parseNumericParts(value: string): number[] {
  return value.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

function compareNumericParts(a: string, b: string): number {
  const numA = parseNumericParts(a);
  const numB = parseNumericParts(b);
  const maxLen = Math.max(numA.length, numB.length);
  for (let i = 0; i < maxLen; i++) {
    const diff = (numA[i] ?? 0) - (numB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function comparePrerelease(a: string, b: string): number {
  if (a === "" && b === "") return 0;
  if (a === "") return 1;
  if (b === "") return -1;

  const preA = a.split(".");
  const preB = b.split(".");
  const preLen = Math.max(preA.length, preB.length);
  for (let i = 0; i < preLen; i++) {
    const pA = preA[i] ?? "";
    const pB = preB[i] ?? "";
    if (pA === pB) continue;
    const nA = Number.parseInt(pA, 10);
    const nB = Number.parseInt(pB, 10);
    if (!Number.isNaN(nA) && !Number.isNaN(nB)) return nA - nB;
    return pA.localeCompare(pB);
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const versionA = splitVersion(a);
  const versionB = splitVersion(b);
  const numeric = compareNumericParts(versionA.release, versionB.release);
  if (numeric !== 0) return numeric;
  return comparePrerelease(versionA.prerelease, versionB.prerelease);
}

/**
 * NuGet interval notation:
 *   [1.0.0, 2.0.0)  -> >= 1.0.0 AND < 2.0.0
 *   (1.0.0, 2.0.0]  -> > 1.0.0 AND <= 2.0.0
 *   [1.0.0, )       -> >= 1.0.0
 *   (, 2.0.0)       -> < 2.0.0
 *   [1.0.0]         -> exact
 */
export function isVersionInRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed) return false;

  const lowerInclusive = trimmed.startsWith("[");
  const upperInclusive = trimmed.endsWith("]");
  const inner = trimmed.slice(1, -1);
  const commaIdx = inner.indexOf(",");

  if (commaIdx === -1) {
    return lowerInclusive && upperInclusive && compareVersions(version, inner.trim()) === 0;
  }

  return satisfiesLowerBound(version, inner.substring(0, commaIdx).trim(), lowerInclusive)
    && satisfiesUpperBound(version, inner.substring(commaIdx + 1).trim(), upperInclusive);
}

function satisfiesLowerBound(version: string, bound: string, inclusive: boolean): boolean {
  if (!bound) return true;
  const cmp = compareVersions(version, bound);
  return inclusive ? cmp >= 0 : cmp > 0;
}

function satisfiesUpperBound(version: string, bound: string, inclusive: boolean): boolean {
  if (!bound) return true;
  const cmp = compareVersions(version, bound);
  return inclusive ? cmp <= 0 : cmp < 0;
}

/** Lowercased release version used by vulnerability lists. */
export function normalizeVersion(version: string): string {
  return version.split("+")[0]!.toLowerCase();
}

/**
 * Evaluates a NuGet dependency range against a concrete version.
 *
 * - interval / exact notation is delegated to `isVersionInRange`
 *   (`[1.0.0]`, `[1.0.0, 2.0.0)`, ...)
 * - a bare version means "at least" (NuGet's shorthand in nuspec files)
 * - floating ranges such as `1.*` / `1.2.*` match the prefix
 * - `*` matches everything
 *
 * An empty or unparseable range is treated as unconstrained so a suggestion is
 * never hidden because the metadata could not be understood.
 */
export function satisfiesVersionRange(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === "*") return true;

  if (/[[\]()]/.test(trimmed)) {
    // Interval notation is only meaningful when it is actually a range. A bare
    // value in parentheses would already be caught above.
    return isVersionInRange(version, trimmed);
  }

  if (trimmed.endsWith(".*")) {
    const prefix = trimmed.slice(0, -1);
    return version.toLowerCase().startsWith(prefix.toLowerCase());
  }

  return compareVersions(version, trimmed) >= 0;
}
