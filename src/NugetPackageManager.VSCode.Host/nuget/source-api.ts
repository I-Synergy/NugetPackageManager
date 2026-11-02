/**
 * Contract between the VS Code host and a NuGet source implementation.
 *
 * Two implementations satisfy it: the TypeScript client in `api.ts` and the
 * C# sidecar adapter. Everything else in the host reaches a source through
 * `nugetApiFactory`, so swapping implementations never touches a call site.
 *
 * The three `Clear*` methods are lifecycle hooks, not data operations: they
 * exist because the factory owns cache invalidation for whichever
 * implementation it handed out. The sidecar maps them onto its own caches.
 */

export type GetPackagesResponse = {
  data: Array<Package>;
};

export type GetPackageResponse = {
  isError: boolean;
  errorMessage: string | undefined;
  data: Package | undefined;
};

export type GetPackageDetailsResponse = {
  data: PackageDetails;
};

export type GetPackageFrameworksResponse = {
  data: PackageFrameworks;
};

export interface INuGetSourceApi {
  GetPackagesAsync(
    filter: string,
    prerelease: boolean,
    skip: number,
    take: number,
    signal?: AbortSignal
  ): Promise<GetPackagesResponse>;

  GetPackageAsync(
    id: string,
    prerelease?: boolean,
    signal?: AbortSignal
  ): Promise<GetPackageResponse>;

  GetPackageDetailsAsync(
    packageId: string,
    version: string,
    signal?: AbortSignal
  ): Promise<GetPackageDetailsResponse>;

  /**
   * Frameworks one package version supports, grouped by product. Read from the
   * package's own assets, so it needs the `.nupkg` rather than only its metadata.
   */
  GetPackageFrameworksAsync(
    packageId: string,
    version: string,
    signal?: AbortSignal
  ): Promise<GetPackageFrameworksResponse>;

  GetVulnerabilitiesAsync(signal?: AbortSignal): Promise<Map<string, VulnerabilityEntry[]>>;

  /** Drops cached metadata, for one package id or (without an id) for all of them. */
  ClearPackageCache(packageId?: string): void;

  ClearVulnerabilityCache(): void;

  /** Removes any persisted HTTP cache (used by ForceReload). */
  ClearHttpCache(): void;
}
