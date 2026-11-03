import * as vscode from "vscode";
import { createHostAPI } from "./host-api";
import { Logger } from "@/common/logger";
import { PackageVersionDecorator } from "./utilities/package-version-decorator";
import nugetApiFactory from "./nuget/api-factory";
import coreProcess from "./nuget/core-process";
import { RegisterBadgeView, SetUpdateBadge } from "./view-badge";
import { getSetting } from "@/common/configuration";
import { COMMAND_IDS, NUGET_VIEW_CONTEXT, PANEL_ID, VIEW_ID } from "./extension-ids";
import { NugetWebviewManager } from "./webview-manager";
import { NugetLauncherTreeProvider } from "./launcher-tree-provider";
import { workspaceSnapshot } from "./utilities/workspace-snapshot";

export function activate(context: vscode.ExtensionContext) {
  Logger.configure(context);
  Logger.info("Extension.activate: Extension activated");


  coreProcess.Configure(context.extensionPath);

  const webviews = new NugetWebviewManager(context.extensionUri, context);
  context.subscriptions.push(webviews);

  let badgeTimer: NodeJS.Timeout | undefined;
  let badgeRefreshInFlight = false;

  const refreshUpdateBadgeAsync = async (): Promise<void> => {
    if (badgeRefreshInFlight) return;
    badgeRefreshInFlight = true;
    try {
      const prerelease = getSetting<boolean>("prerelease", false);
      const result = await createHostAPI(context).getOutdatedPackagesAsync({ Prerelease: prerelease });
      if (result.ok) SetUpdateBadge(result.value.Packages.length, result.value.BlockedPackages?.length ?? 0);
    } catch (err) {
      Logger.warn(`NuGet badge refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      badgeRefreshInFlight = false;
    }
  };

  const startBadgeTimer = (): void => {
    if (badgeTimer) return;
    // The tree view is created after this context check; give VS Code a moment
    // to register it before the first badge result is applied.
    setTimeout(() => { void refreshUpdateBadgeAsync(); }, 1000);
    badgeTimer = setInterval(() => { void refreshUpdateBadgeAsync(); }, 15 * 60 * 1000);
  };

  const stopBadgeTimer = (): void => {
    if (badgeTimer) {
      clearInterval(badgeTimer);
      badgeTimer = undefined;
    }
  };
  context.subscriptions.push({ dispose: stopBadgeTimer });

  // Keep the Activity Bar entry hidden until the workspace contains a project
  // type that can consume NuGet packages. The view contribution itself is
  // guarded by the same context key, so non-.NET workspaces stay uncluttered.
  const updateNugetViewContextAsync = async (): Promise<void> => {
    let hasSupportedProjects = false;
    if ((vscode.workspace.workspaceFolders?.length ?? 0) > 0) {
      const projects = await vscode.workspace.findFiles(
        "**/*.{csproj,fsproj,vbproj}",
        "**/{bin,obj,node_modules,.git}/**"
      );
      hasSupportedProjects = projects.length > 0;
    }
    await vscode.commands.executeCommand("setContext", NUGET_VIEW_CONTEXT, hasSupportedProjects);
    if (hasSupportedProjects) {
      startBadgeTimer();
    } else {
      stopBadgeTimer();
      SetUpdateBadge(0);
    }
  };

  void updateNugetViewContextAsync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void updateNugetViewContextAsync();
    })
  );

  let projectDiscoveryTimeout: NodeJS.Timeout | undefined;
  const scheduleProjectDiscovery = () => {
    if (projectDiscoveryTimeout) clearTimeout(projectDiscoveryTimeout);
    projectDiscoveryTimeout = setTimeout(() => {
      void updateNugetViewContextAsync();
    }, 250);
  };
  const projectWatcher = vscode.workspace.createFileSystemWatcher("**/*.{csproj,fsproj,vbproj}");
  projectWatcher.onDidCreate(scheduleProjectDiscovery);
  projectWatcher.onDidDelete(scheduleProjectDiscovery);
  context.subscriptions.push(projectWatcher);

  const previousVersion: string | undefined = context.globalState.get("nugetpackagemanager.version");
  void context.globalState.update("nugetpackagemanager.version", context.extension.packageJSON.version);
  if (previousVersion == undefined) {
    Logger.info("Extension.activate: Extension installed");
  } else if (previousVersion != context.extension.packageJSON.version)
    Logger.info("Extension.activate: Extension upgraded from version %s", previousVersion);

  const launcherTree = vscode.window.createTreeView(
    VIEW_ID,
    { treeDataProvider: new NugetLauncherTreeProvider() }
  );
  RegisterBadgeView(launcherTree);
  context.subscriptions.push(
    new PackageVersionDecorator(),
    launcherTree,
    launcherTree.onDidChangeVisibility((event) => {
      if (event.visible) webviews.openPanel();
    }),
    vscode.window.registerWebviewPanelSerializer(PANEL_ID, {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel) => {
        webviews.restorePanel(panel);
        return Promise.resolve();
      },
    }),
    vscode.commands.registerCommand(COMMAND_IDS.open, () => {
      webviews.openPanel();
    }),
    vscode.commands.registerCommand(COMMAND_IDS.install, async () => {
      const packageId = await vscode.window.showInputBox({
        prompt: "Enter the NuGet package ID to install",
        placeHolder: "e.g. Newtonsoft.Json",
      });
      if (!packageId) return;
      webviews.openPanel();
      webviews.sendSearchQuery(packageId);
    }),
    vscode.commands.registerCommand(COMMAND_IDS.update, () => {
      webviews.openPanel();
      webviews.sendNavigateToTab("updates");
    }),
    vscode.commands.registerCommand(COMMAND_IDS.remove, () => {
      webviews.openPanel();
      webviews.sendNavigateToTab("installed");
    }),
    vscode.commands.registerCommand(COMMAND_IDS.reportProblem, () => {
      void vscode.env.openExternal(
        vscode.Uri.parse("https://github.com/I-Synergy/NugetPackageManager/issues/new")
      );
    }),
    vscode.commands.registerCommand(COMMAND_IDS.openSettings, () => {
      webviews.openPanel();
      webviews.sendNavigateToRoute("SETTINGS");
    }),
    vscode.commands.registerCommand(COMMAND_IDS.copyToolchainDiagnostics, async () => {
      const result = await createHostAPI(context).runToolchainDiagnosticsAsync({});
      if (!result.ok) {
        void vscode.window.showErrorMessage(`Could not collect toolchain diagnostics: ${result.error}`);
        return;
      }
      await vscode.env.clipboard.writeText(result.value.Report);
      void vscode.window.showInformationMessage(
        "dotnet toolchain diagnostics copied to the clipboard (credentials redacted)."
      );
    })
  );

  const nugetConfigWatcher = vscode.workspace.createFileSystemWatcher(
    "**/{nuget.config,NuGet.Config,NuGet.config}"
  );
  let nugetConfigChangeTimeout: NodeJS.Timeout | undefined;
  const onNugetConfigChanged = () => {
    if (nugetConfigChangeTimeout) {
      clearTimeout(nugetConfigChangeTimeout);
    }
    nugetConfigChangeTimeout = setTimeout(() => {
      webviews.sendReloadConfiguration();
    }, 200);
  };
  nugetConfigWatcher.onDidChange(onNugetConfigChanged);
  nugetConfigWatcher.onDidCreate(onNugetConfigChanged);
  nugetConfigWatcher.onDidDelete(onNugetConfigChanged);
  context.subscriptions.push(nugetConfigWatcher);
}

// This method is called when your extension is deactivated
export function deactivate() {
  coreProcess.Dispose();
  nugetApiFactory.ClearCache();
  // Aborts an in-flight workspace parse and disposes the file-system watcher.
  workspaceSnapshot.dispose();
  Logger.info("Extension.deactivate: Extension deactivated");
}
