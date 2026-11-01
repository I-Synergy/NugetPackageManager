const severityLabels: Record<VulnerableSeverity, string> = {
  0: "Low",
  1: "Medium",
  2: "High",
  3: "Critical",
};

export class VulnerablePackageViewModel {
  Id: string;
  InstalledVersion: string;
  Severity: VulnerableSeverity;
  SeverityLabel: string;
  AdvisoryUrl: string;
  AffectedVersionRange: string;
  Projects: Array<{ Name: string; Path: string }>;
  CpmFrameworks: string[];
  IsTransitive: boolean;
  DependencyOf: string[];

  constructor(model: VulnerablePackage) {
    this.Id = model.Id;
    this.InstalledVersion = model.InstalledVersion;
    this.Severity = model.Severity;
    this.SeverityLabel = severityLabels[model.Severity];
    this.AdvisoryUrl = model.AdvisoryUrl;
    this.AffectedVersionRange = model.AffectedVersionRange;
    this.Projects = model.Projects;
    this.CpmFrameworks = model.CpmFrameworks ?? [];
    this.IsTransitive = model.IsTransitive ?? false;
    this.DependencyOf = model.DependencyOf ?? [];
  }
}
