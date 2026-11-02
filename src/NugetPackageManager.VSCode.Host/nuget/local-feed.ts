import fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import { Logger } from "@/common/logger";
import { compareVersions } from "../utilities/version";

type NuspecMetadata = {
  Id: string;
  Version: string;
  Authors: string[];
  Description: string;
  IconUrl: string;
  LicenseUrl: string;
  ProjectUrl: string;
  Tags: string[];
  Dependencies: PackageDetails["dependencies"];
};

type IndexedPackage = {
  nupkgPath: string;
  metadata: NuspecMetadata;
};

/**
 * Reads a local folder-based NuGet feed. Local feeds are directories that
 * contain `.nupkg` files, either flat or in the usual id/version layout.
 */
export default class LocalNuGetFeed {
  private static readonly INDEX_TTL_MS = 30_000;
  private readonly root: string;
  private index = new Map<string, IndexedPackage[]>();
  private indexedAt = 0;

  constructor(sourceUrl: string) {
    this.root = LocalNuGetFeed.ToLocalPath(sourceUrl);
  }

  static IsLocalSource(sourceUrl: string): boolean {
    const value = sourceUrl.trim();
    if (!value) return false;
    if (/^file:/i.test(value)) return true;
    if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
    if (value.startsWith("\\\\")) return true;
    return path.isAbsolute(value);
  }

  private static ToLocalPath(sourceUrl: string): string {
    return /^file:/i.test(sourceUrl)
      ? fileURLToPath(sourceUrl)
      : path.normalize(sourceUrl);
  }

  async GetPackagesAsync(
    filter: string,
    prerelease: boolean,
    skip: number,
    take: number,
    signal?: AbortSignal
  ): Promise<Package[]> {
    const packages = await this.GetPackageListAsync(prerelease, signal);
    const query = filter.trim().toLowerCase();
    const matching = query
      ? packages.filter((pkg) =>
          [pkg.Id, pkg.Description, pkg.Tags.join(" "), pkg.Authors.join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(query)
        )
      : packages;

    return matching.slice(skip, skip + take);
  }

  async GetPackageAsync(
    packageId: string,
    prerelease: boolean,
    signal?: AbortSignal
  ): Promise<Package | undefined> {
    const packages = await this.GetPackageListAsync(prerelease, signal);
    return packages.find((pkg) => pkg.Id.toLowerCase() === packageId.toLowerCase());
  }

  async GetPackageDetailsAsync(packageId: string, version: string): Promise<PackageDetails> {
    const versions = this.index.get(packageId.toLowerCase()) ?? [];
    const entry = versions.find(
      (candidate) => candidate.metadata.Version.toLowerCase() === version.toLowerCase()
    );
    const metadata = entry ? await this.ReadNuspecAsync(entry.nupkgPath) : undefined;
    return metadata
      ? { dependencies: metadata.Dependencies }
      : { dependencies: { frameworks: {} } };
  }

  ClearCache(): void {
    this.index.clear();
    this.indexedAt = 0;
  }

  private async GetPackageListAsync(
    prerelease: boolean,
    signal?: AbortSignal
  ): Promise<Package[]> {
    await this.RefreshIndexAsync(signal);
    const packages: Package[] = [];

    for (const versions of this.index.values()) {
      if (signal?.aborted) break;
      const allowed = versions
        .filter((entry) => prerelease || !entry.metadata.Version.includes("-"))
        .sort((a, b) => compareVersions(a.metadata.Version, b.metadata.Version));
      const latest = allowed[allowed.length - 1];
      if (!latest) continue;

      const first = latest.metadata;
      packages.push({
        Id: first.Id,
        Name: first.Id,
        Authors: first.Authors,
        Description: first.Description,
        IconUrl: first.IconUrl,
        LicenseUrl: first.LicenseUrl,
        ProjectUrl: first.ProjectUrl,
        Registration: "",
        TotalDownloads: null,
        Verified: null,
        InstalledVersion: "",
        Version: latest.metadata.Version,
        // A folder feed publishes no download data, so the honest value is null.
        Versions: allowed.map((entry) => ({ Version: entry.metadata.Version, Downloads: null })),
        Tags: first.Tags,
      });
    }

    return packages.sort((a, b) => a.Id.localeCompare(b.Id));
  }

  private async RefreshIndexAsync(signal?: AbortSignal): Promise<void> {
    if (this.index.size > 0 && Date.now() - this.indexedAt < LocalNuGetFeed.INDEX_TTL_MS) {
      return;
    }

    const next = new Map<string, IndexedPackage[]>();
    let rootExists = true;
    try {
      const stat = await fs.promises.stat(this.root);
      rootExists = stat.isDirectory();
    } catch {
      rootExists = false;
    }
    if (!rootExists) {
      Logger.warn(`LocalNuGetFeed: Local source does not exist: ${this.root}`);
      this.index = next;
      this.indexedAt = Date.now();
      return;
    }

    await this.ScanDirectoryAsync(this.root, next, signal);
    if (signal?.aborted) return;
    this.index = next;
    this.indexedAt = Date.now();
  }

  private async ScanDirectoryAsync(
    directory: string,
    target: Map<string, IndexedPackage[]>,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (err) {
      Logger.warn(`LocalNuGetFeed: Cannot read ${directory}: ${String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) return;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.ScanDirectoryAsync(entryPath, target, signal);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".nupkg")) continue;

      const metadata = await this.ReadNuspecAsync(entryPath);
      if (!metadata) continue;
      const key = metadata.Id.toLowerCase();
      const list = target.get(key) ?? [];
      if (!list.some((pkg) => pkg.metadata.Version.toLowerCase() === metadata.Version.toLowerCase())) {
        list.push({ nupkgPath: entryPath, metadata });
        target.set(key, list);
      }
    }
  }

  private async ReadNuspecAsync(nupkgPath: string): Promise<NuspecMetadata | null> {
    try {
      const archive = await JSZip.loadAsync(await fs.promises.readFile(nupkgPath));
      const nuspecName = Object.keys(archive.files).find((name) =>
        name.toLowerCase().endsWith(".nuspec")
      );
      if (!nuspecName) return null;
      const file = archive.file(nuspecName);
      if (!file) return null;
      return this.ParseNuspec(await file.async("string"));
    } catch (err) {
      Logger.warn(`LocalNuGetFeed: Cannot read ${nupkgPath}: ${String(err)}`);
      return null;
    }
  }

  private ParseNuspec(content: string): NuspecMetadata | null {
    const document = new DOMParser().parseFromString(content);
    const value = (name: string): string =>
      String(
        xpath.select(`string(//*[local-name()='metadata']/*[local-name()='${name}'])`, document)
      ).trim();

    const id = value("id");
    const version = value("version");
    if (!id || !version) return null;
    const dependencies: PackageDetails["dependencies"] = { frameworks: {} };

    const groups = xpath.select("//*[local-name()='dependencies']/*[local-name()='group']", document) as Node[];
    const dependencyNodes = groups.length > 0
      ? groups
      : (xpath.select("//*[local-name()='dependencies']/*[local-name()='dependency']", document) as Node[]);

    for (const node of dependencyNodes) {
      const element = node as Element;
      const groupFramework = element.getAttribute("targetFramework") ?? "";
      const framework = groupFramework || "";
      const list = dependencies.frameworks[framework] ?? [];
      const dependencyNodesInGroup = groups.length > 0
        ? (xpath.select("./*[local-name()='dependency']", element) as Node[])
        : [element];
      for (const dependencyNode of dependencyNodesInGroup) {
        const dependency = dependencyNode as Element;
        const packageId = dependency.getAttribute("id");
        if (!packageId) continue;
        list.push({
          package: packageId,
          versionRange: dependency.getAttribute("version") ?? "",
        });
      }
      if (list.length > 0) dependencies.frameworks[framework] = list;
    }

    return {
      Id: id,
      Version: version,
      Authors: value("authors").split(",").map((author) => author.trim()).filter(Boolean),
      Description: value("description"),
      IconUrl: value("iconUrl"),
      LicenseUrl: value("licenseUrl"),
      ProjectUrl: value("projectUrl"),
      Tags: value("tags").split(/[,\s]+/).map((tag) => tag.trim()).filter(Boolean),
      Dependencies: dependencies,
    };
  }
}
