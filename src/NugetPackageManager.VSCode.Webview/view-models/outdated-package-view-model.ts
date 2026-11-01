export class OutdatedPackageViewModel {
  Id: string;
  InstalledVersion: string;
  LatestVersion: string;
  LatestOverallVersion: string;
  Projects: Array<{ Name: string; Path: string; Version: string }>;
  SourceUrl: string;
  SourceName: string;
  TotalDownloads: number | null;
  Verified: boolean | null;
  CpmCondition: string;
  CpmFramework: string;
  CpmConditionLabel: string;
  CpmMatched: boolean;
  BlockedBy: Array<{ PackageId: string; InstalledVersion: string; Range: string }>;
  IsUpdating: boolean = false;
  Selected: boolean = false;

  constructor(model: OutdatedPackage) {
    this.Id = model.Id;
    this.InstalledVersion = model.InstalledVersion;
    this.LatestVersion = model.LatestVersion;
    this.LatestOverallVersion = model.LatestOverallVersion ?? "";
    this.Projects = model.Projects;
    this.SourceUrl = model.SourceUrl;
    this.SourceName = model.SourceName;
    this.TotalDownloads = model.TotalDownloads ?? null;
    this.Verified = model.Verified ?? null;
    this.CpmCondition = model.CpmCondition ?? "";
    this.CpmFramework = model.CpmFramework ?? "";
    this.CpmConditionLabel = model.CpmConditionLabel ?? "";
    this.CpmMatched = model.CpmMatched ?? true;
    this.BlockedBy = model.BlockedBy ?? [];
  }

  get blockedReason(): string {
    return this.BlockedBy
      .map((constraint) => `${constraint.PackageId} ${constraint.InstalledVersion} requires ${constraint.Range}`)
      .join("; ");
  }
}
