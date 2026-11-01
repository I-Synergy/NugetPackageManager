export type PackageViewModelStatus = "Detailed" | "MissingDetails" | "Error";

export class PackageViewModel {
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
  Status: PackageViewModelStatus;
  Selected: boolean = false;
  SourceUrl: string = "";
  AllowsUpdate: boolean = true;
  Revision: number = 0;
  CpmFramework: string = "";

  constructor(model: Package, status: PackageViewModelStatus = "Detailed") {
    this._authors = model.Authors;
    this.Id = model.Id;
    this.Name = model.Name;
    this.Description = model.Description;
    this.IconUrl = model.IconUrl;
    this.LicenseUrl = model.LicenseUrl;
    this.ProjectUrl = model.ProjectUrl;
    this.TotalDownloads = model.TotalDownloads;
    this.Verified = model.Verified;
    this.Version = model.Version;
    this.InstalledVersion = model.InstalledVersion;
    this.Versions = model.Versions?.map((x) => x.Version).reverse() ?? [];
    this._tags = model.Tags;
    this.Model = model;
    this.Status = status;
  }

  UpdatePackage(model: Package, sourceUrl?: string) {
    this._authors = model.Authors;
    this.Id = model.Id;
    this.Name = model.Name;
    this.Description = model.Description;
    this.IconUrl = model.IconUrl;
    this.LicenseUrl = model.LicenseUrl;
    this.ProjectUrl = model.ProjectUrl;
    this.TotalDownloads = model.TotalDownloads;
    this.Verified = model.Verified;
    if (model.Version != "") this.Version = model.Version;
    this.Versions = model.Versions?.map((x) => x.Version).reverse() ?? [];
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
