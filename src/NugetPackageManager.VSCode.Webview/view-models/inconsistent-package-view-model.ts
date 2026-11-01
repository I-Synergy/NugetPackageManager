export class InconsistentPackageViewModel {
  Id: string;
  Versions: Array<{
    Version: string;
    Projects: Array<{ Name: string; Path: string }>;
    CpmFramework: string;
    CpmCondition: string;
    CpmConditionLabel: string;
  }>;
  LatestInstalledVersion: string;
  CpmManaged: boolean;
  TargetVersion: string;
  IsConsolidating: boolean = false;

  constructor(model: InconsistentPackage) {
    this.Id = model.Id;
    this.Versions = model.Versions.map((v) => ({
      ...v,
      CpmFramework: v.CpmFramework ?? "",
      CpmCondition: v.CpmCondition ?? "",
      CpmConditionLabel: v.CpmConditionLabel ?? "",
    }));
    this.LatestInstalledVersion = model.LatestInstalledVersion;
    this.CpmManaged = model.CpmManaged;
    this.TargetVersion = model.LatestInstalledVersion;
  }
}
