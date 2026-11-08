export type PackageViewModelStatus = "Detailed" | "MissingDetails" | "Error";

export class PackageViewModel {
  /**
   * The one placeholder for a package the UI knows only by id (Installed / Updates rows).
   * Metadata is unknown until a lookup fills it in, so it is null rather than 0/false.
   */
  static Empty(id: string, status: PackageViewModelStatus = "MissingDetails"): PackageViewModel {
    return new PackageViewModel({
      Id: id,
      Name: id,
      Authors: [],
      Description: "",
      IconUrl: "",
      LicenseUrl: "",
      ProjectUrl: "",
      Registration: "",
      TotalDownloads: null,
      Verified: null,
      InstalledVersion: "",
      Version: "",
      Versions: [],
      Tags: [],
    }, status);
  }

  Id: string;
  Name: string;
  Model: Package;
  private _authors: Array<string>;
  private _tags: Array<string>;
  Description: string;
  IconUrl: string;
  LicenseUrl: string;
  ProjectUrl: string;
  TotalDownloads: number | null;
  Verified: boolean | null;
  InstalledVersion: string;
  Version: string;
  Versions: Array<string>;
  /**
   * Downloads per exact version, keyed by the same strings as `Versions`. A version
   * the feed did not publish a count for maps to `null`, never `0`.
   */
  VersionDownloads: Map<string, number | null>;
  Status: PackageViewModelStatus;
  Selected: boolean = false;
  SourceUrl: string = "";
  AllowsUpdate: boolean = true;
  Revision: number = 0;
  CpmFramework: string = "";
  /** Row TFM used to cap cross-major recommendations; empty when the row has none. */
  LaneFramework: string = "";

  constructor(model: Package, status: PackageViewModelStatus = "Detailed") {
    this._authors = model.Authors;
    this.Id = model.Id;
    this.Name = model.Name;
    this.Description = model.Description;
    this.IconUrl = model.IconUrl;
    this.LicenseUrl = model.LicenseUrl;
    this.ProjectUrl = model.ProjectUrl;
    this.TotalDownloads = model.TotalDownloads ?? null;
    this.Verified = model.Verified;
    this.Version = model.Version;
    this.InstalledVersion = model.InstalledVersion;
    this.Versions = model.Versions?.map((x) => x.Version).reverse() ?? [];
    this.VersionDownloads = PackageViewModel.BuildVersionDownloads(model.Versions);
    this.SourceUrl = model.SourceUrl ?? "";
    this._tags = model.Tags;
    this.Model = model;
    this.Status = status;
  }

  /**
   * Index the per-version counts the feed published. Versions the search resource
   * never reported land here as `null` so the UI can tell "unknown" from "none".
   */
  private static BuildVersionDownloads(versions: PackageVersion[] | undefined): Map<string, number | null> {
    const downloads = new Map<string, number | null>();
    for (const entry of versions ?? []) {
      if (!entry || typeof entry.Version !== "string") continue;
      downloads.set(entry.Version, entry.Downloads ?? null);
    }
    return downloads;
  }

  /** Downloads of one exact version; `null` when the feed does not publish it. */
  DownloadsForVersion(version: string): number | null {
    if (!version) return null;
    return this.VersionDownloads.get(version) ?? null;
  }

  UpdatePackage(model: Package, sourceUrl?: string) {
    this._authors = model.Authors;
    this.Id = model.Id;
    this.Name = model.Name;
    this.Description = model.Description;
    this.IconUrl = model.IconUrl;
    this.LicenseUrl = model.LicenseUrl;
    this.ProjectUrl = model.ProjectUrl;
    this.TotalDownloads = model.TotalDownloads ?? null;
    this.Verified = model.Verified;
    if (model.Version != "") this.Version = model.Version;
    this.Versions = model.Versions?.map((x) => x.Version).reverse() ?? [];
    this.VersionDownloads = PackageViewModel.BuildVersionDownloads(model.Versions);
    this._tags = model.Tags;
    this.Model = model;
    if (sourceUrl) this.SourceUrl = sourceUrl;
    this.Revision++;
  }

  get Authors() {
    if (Array.isArray(this._authors)) {
      return this._authors.length ? this._authors.join(", ") : "";
    } else if (typeof this._authors === "string") {
      return this._authors;
    }
    return "";
  }

  get Tags() {
    if (Array.isArray(this._tags)) {
      return this._tags.length ? this._tags.join(", ") : "";
    } else if (typeof this._tags === "string") {
      return this._tags;
    }
    return "";
  }
}
