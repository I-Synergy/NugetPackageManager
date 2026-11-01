export class ProjectPackageViewModel {
  Id: string;
  Version: string;
  IsPinned: boolean;
  VersionSource: VersionSource;
  CpmFramework: string;
  CpmResolutions: CpmResolution[];

  constructor(model: ProjectPackage) {
    this.Id = model.Id;
    this.Version = model.Version;
    this.IsPinned = model.IsPinned;
    this.VersionSource = model.VersionSource;
    this.CpmFramework = model.CpmFramework ?? "";
    this.CpmResolutions = model.CpmResolutions ?? [];
  }
}
