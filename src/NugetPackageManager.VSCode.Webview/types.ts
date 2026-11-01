// Barrel for the webview view models. Each view model lives in its own file under
// `view-models/`; importing from `@/web/types` keeps working for every consumer.
export { PackageViewModel } from "./view-models/package-view-model";
export type { PackageViewModelStatus } from "./view-models/package-view-model";
export { ProjectPackageViewModel } from "./view-models/project-package-view-model";
export { ProjectViewModel } from "./view-models/project-view-model";
export { OutdatedPackageViewModel } from "./view-models/outdated-package-view-model";
export { InconsistentPackageViewModel } from "./view-models/inconsistent-package-view-model";
export { VulnerablePackageViewModel } from "./view-models/vulnerable-package-view-model";
export { SourceViewModel } from "./view-models/source-view-model";
