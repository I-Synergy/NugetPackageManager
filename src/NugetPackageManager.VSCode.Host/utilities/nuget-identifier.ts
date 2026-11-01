const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const VERSION_RE = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** NuGet package ID grammar: letters/digits/._-, 1-100 chars, alphanumeric start. */
export function isValidPackageId(value: string): boolean {
  return PACKAGE_ID_RE.test(value);
}

/** NuGet version grammar (1-4 numeric parts, optional prerelease/build metadata). */
export function isValidNuGetVersion(value: string): boolean {
  return VERSION_RE.test(value);
}
