// Identifiers shared by the extension entry point, the webview manager and the
// launcher tree provider. They mirror the contributions in `package.json`.
export const NUGET_VIEW_CONTEXT = "nuget.hasSupportedProjects";
export const PANEL_ID = "nugetpackagemanager.panel";
export const VIEW_ID = "nugetpackagemanager.launcherView";

export const COMMAND_IDS = {
  open: "nugetpackagemanager.open",
  install: "nugetpackagemanager.install",
  update: "nugetpackagemanager.update",
  remove: "nugetpackagemanager.remove",
  reportProblem: "nugetpackagemanager.reportProblem",
  openSettings: "nugetpackagemanager.openSettings",
  copyToolchainDiagnostics: "nugetpackagemanager.copyToolchainDiagnostics",
} as const;
