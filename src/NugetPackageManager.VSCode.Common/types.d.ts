type Package = {
  Id: string;
  Name: string;
  Authors: Array<string>;
  Description: string;
  IconUrl: string;
  LicenseUrl: string;
  ProjectUrl: string;
  Registration: string;
  TotalDownloads: number;
  Verified: boolean;
  InstalledVersion: string;
  Version: string;
  Versions: Array<PackageVersion>;
  Tags: Array<string>;
};

type PackageVersion = {
  Version: string;
  Id: string;
};

type PackageDetails = {
  dependencies: PackageDependencyGroup;
};

type PackageDependencyGroup = {
  frameworks: { [id: string]: Array<PackageDependency> };
};

type PackageDependency = {
  package: string;
  versionRange: string;
};

type VersionSource = "project" | "central" | "override";

type CpmResolution = {
  Tfm: string;              // "" for unconditional/shared versions
  Version: string;
  Condition: string;        // "" for unconditional
  ConditionLabel: string;
  Matched: boolean;         // false when no condition matched the project's TFMs
};

type ProjectPackage = {
  Id: string;
  Version: string;
  IsPinned: boolean;
  VersionSource: VersionSource;
  CpmFramework?: string;  // framework label if from a conditional CPM group, e.g. "net8.0"
  CpmResolutions?: Array<CpmResolution>;
};

type Project = {
  Name: string;
  Path: string;
  Packages: Array<ProjectPackage>;
  CpmEnabled: boolean;
  TargetFrameworks?: Array<string>;
  TfmSource?: string;
};

type Source = {
  Name: string;
  Url: string;
  PasswordScriptPath?: string;
};

type Configuration = {
  SkipRestore: boolean;
  EnablePackageVersionInlineInfo: boolean;
  Prerelease: boolean;
  Sources: Array<Source>;
  StatusBarLoadingIndicator: boolean;
};

type OutdatedPackage = {
  Id: string;
  InstalledVersion: string;
  LatestVersion: string;
  LatestOverallVersion?: string;    // overall latest when it crosses the TFM's major line
  Projects: Array<{ Name: string; Path: string; Version: string }>;
  SourceUrl: string;
  SourceName: string;
  CpmCondition?: string;   // raw XML Condition string; absent = unconditional
  CpmFramework?: string;   // resolved TFM, e.g. "net10.0"; absent = unconditional
  CpmConditionLabel?: string; // disambiguated condition label, e.g. "not net11.0"
  CpmMatched?: boolean;    // false when the condition matched none of the project's TFMs
  BlockedBy?: Array<{      // dependencies whose declared range rejects LatestOverallVersion
    PackageId: string;
    InstalledVersion: string;
    Range: string;
  }>;
};

type InconsistentPackage = {
  Id: string;
  Versions: Array<{
    Version: string;
    Projects: Array<{ Name: string; Path: string }>;
    CpmFramework?: string;  // framework label if version is framework-conditional
    CpmCondition?: string;
    CpmConditionLabel?: string;
  }>;
  LatestInstalledVersion: string;
  CpmManaged: boolean;
};

type VulnerableSeverity = 0 | 1 | 2 | 3; // Low | Medium | High | Critical

type VulnerabilityEntry = {
  url: string;
  severity: VulnerableSeverity;
  versions: string;
};

type VulnerablePackage = {
  Id: string;
  InstalledVersion: string;
  Severity: VulnerableSeverity;
  AdvisoryUrl: string;
  AffectedVersionRange: string;
  Projects: Array<{ Name: string; Path: string }>;
  CpmFrameworks?: Array<string>;  // TFMs whose resolved version is affected
  IsTransitive?: boolean;          // discovered through project.assets.json
  DependencyOf?: Array<string>;    // direct packages that bring this one in
};

type HttpError = {
  Message: string;
};

type Credentials = {
  Username: string;
  Password: string;
};
