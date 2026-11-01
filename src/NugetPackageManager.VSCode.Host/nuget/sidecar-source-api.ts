import { CoreError } from "./core-client";
import coreProcess from "./core-process";
import LocalNuGetFeed from "./local-feed";
import type {
  GetPackageDetailsResponse,
  GetPackageResponse,
  GetPackagesResponse,
  INuGetSourceApi,
} from "./source-api";

/**
 * `INuGetSourceApi` over the C# core.
 *
 * Folder-based sources still run in TypeScript: they read `.nupkg` files from disk and the
 * core has no local-feed reader yet, so those calls keep using `LocalNuGetFeed`.
 */
export default class SidecarSourceApi implements INuGetSourceApi {
  private readonly localFeed: LocalNuGetFeed | null;
  private readonly source: Record<string, string>;

  constructor(url: string, username?: string, password?: string, proxy?: string) {
    this.localFeed = LocalNuGetFeed.IsLocalSource(url) ? new LocalNuGetFeed(url) : null;
    this.source = {
      url,
      ...(username !== undefined && username !== "" && { username }),
      ...(password !== undefined && password !== "" && { password }),
      ...(proxy !== undefined && proxy !== "" && { proxy }),
    };
  }

  public async GetPackagesAsync(
    filter: string,
    prerelease: boolean,
    skip: number,
    take: number,
    signal?: AbortSignal
  ): Promise<GetPackagesResponse> {
    if (this.localFeed) {
      return { data: await this.localFeed.GetPackagesAsync(filter, prerelease, skip, take, signal) };
    }

    const data = await this.CallAsync<Array<Package>>("getPackages", { filter, prerelease, skip, take }, signal);
    return { data };
  }

  public async GetPackageAsync(
    id: string,
    prerelease: boolean = true,
    signal?: AbortSignal
  ): Promise<GetPackageResponse> {
    if (this.localFeed) {
      const localPackage = await this.localFeed.GetPackageAsync(id, prerelease, signal);
      return localPackage
        ? { data: localPackage, isError: false, errorMessage: undefined }
        : { data: undefined, isError: true, errorMessage: "Package couldn't be found" };
    }

    try {
      const data = await this.CallAsync<Package>("getPackage", { id, prerelease }, signal);
      return { data, isError: false, errorMessage: undefined };
    } catch (error) {
      if (error instanceof CoreError && error.code === "packageNotFound") {
        return { data: undefined, isError: true, errorMessage: error.message };
      }

      throw error;
    }
  }

  public async GetPackageDetailsAsync(
    packageVersionUrl: string,
    signal?: AbortSignal
  ): Promise<GetPackageDetailsResponse> {
    if (this.localFeed) {
      return { data: await this.localFeed.GetPackageDetailsAsync(packageVersionUrl) };
    }

    const data = await this.CallAsync<PackageDetails>("getPackageDetails", { packageVersionUrl }, signal);
    return { data };
  }

  public async GetVulnerabilitiesAsync(signal?: AbortSignal): Promise<Map<string, Array<VulnerabilityEntry>>> {
    if (this.localFeed) {
      return new Map();
    }

    const response = await this.CallAsync<{ entries: Record<string, Array<VulnerabilityEntry>> }>(
      "getVulnerabilities",
      {},
      signal
    );

    return new Map(Object.entries(response.entries));
  }

  /**
   * Cache control is fire-and-forget: the interface is synchronous, so the request is
   * queued and its failure is logged by the client rather than thrown into a caller that
   * cannot await it.
   */
  public ClearPackageCache(packageId?: string): void {
    this.localFeed?.ClearCache();
    coreProcess.Notify("clearPackageCache", packageId === undefined ? {} : { packageId });
  }

  public ClearVulnerabilityCache(): void {
    coreProcess.Notify("clearVulnerabilityCache", {});
  }

  public ClearHttpCache(): void {
    // The core keeps no on-disk HTTP cache yet; nothing to drop.
  }

  private async CallAsync<T>(
    method: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    return coreProcess.CallAsync<T>(method, { source: this.source, ...parameters }, signal);
  }
}
