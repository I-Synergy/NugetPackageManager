import { ProjectPackageViewModel } from "./project-package-view-model";

export class ProjectViewModel {
  Name: string;
  Path: string;
  CpmEnabled: boolean;
  Packages: ProjectPackageViewModel[];
  TargetFrameworks: string[];
  TfmSource: string;

  constructor(model: Project) {
    this.Name = model.Name;
    this.Path = model.Path;
    this.CpmEnabled = model.CpmEnabled;
    this.Packages = model.Packages.map((x) => new ProjectPackageViewModel(x));
    this.TargetFrameworks = model.TargetFrameworks ?? [];
    this.TfmSource = model.TfmSource ?? "";
  }
}
