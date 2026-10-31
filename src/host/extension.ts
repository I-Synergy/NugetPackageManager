import * as vscode from "vscode";
import * as path from "node:path";
import nonce from "@/common/nonce";
import { RpcHost } from "@/common/rpc/rpc-host";
import { createHostAPI } from "./host-api";
import { Logger } from "../common/logger";
import { PackageVersionDecorator } from "./utilities/package-version-decorator";
import nugetApiFactory from "./nuget/api-factory";
import { RegisterBadgeView, SetUpdateBadge } from "./view-badge";
import { getSetting } from "../common/configuration";

const NUGET_VIEW_CONTEXT = "nuget.hasSupportedProjects";
const PANEL_ID = "nugetpackagemanager.panel";
const VIEW_ID = "nugetpackagemanager.launcherView";

const COMMAND_IDS = {
  open: "nugetpackagemanager.open",
  install: "nugetpackagemanager.install",
  update: "nugetpackagemanager.update",
  remove: "nugetpackagemanager.remove",
  reportProblem: "nugetpackagemanager.reportProblem",
  openSettings: "nugetpackagemanager.openSettings",
  copyToolchainDiagnostics: "nugetpackagemanager.copyToolchainDiagnostics",
} as const;

export function activate(context: vscode.ExtensionContext) {
  Logger.configure(context);
  Logger.info("Extension.activate: Extension activated");


  nugetApiFactory.SetHttpCacheDirectory(path.join(context.globalStorageUri.fsPath, "nuget-http"));

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
  context.globalState.update("nugetpackagemanager.version", context.extension.packageJSON.version);
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
      vscode.env.openExternal(
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

/**
 * Owns the single full-page NuGet editor tab and its RPC host.
 * The tab survives focus changes, is restored after a window reload, and is
 * revealed (rather than duplicated) when a command asks for it again.
 */
class NugetWebviewManager implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private rpcHost: RpcHost | undefined;
  private panelDisposable: vscode.Disposable | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {}

  openPanel(): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return this.panel;
    }

    const panel = vscode.window.createWebviewPanel(
      PANEL_ID,
      "NuGet Package Manager for Visual Studio Code",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      }
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "resources", "nuget-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "resources", "nuget-dark.svg"),
    };
    this.panel = panel;
    this.attachPanel(panel);
    return panel;
  }

  restorePanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.attachPanel(panel);
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.rpcHost?.dispose();
    this.panelDisposable?.dispose();

    // Resolve sources and credentials fresh whenever the page is created.
    nugetApiFactory.ClearCache();

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    panel.webview.html = this.getWebviewHtml(panel.webview);
    this.rpcHost = new RpcHost(panel.webview, createHostAPI(this.context));

    this.panelDisposable = panel.onDidDispose(() => {
      this.rpcHost?.dispose();
      this.rpcHost = undefined;
      this.panelDisposable = undefined;
      this.panel = undefined;
    });
  }

  private getWebviewHtml(webview: vscode.Webview): string {
    const webJsSrc = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "web.js")
    );
    const webCssSrc = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "web.css")
    );
    const nonceValue = nonce();

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width,initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonceValue}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource} data:; connect-src 'none'; base-uri 'none'; form-action 'none';">
          <link rel="stylesheet" type="text/css" href="${webCssSrc}"/>
          <title>NuGet Package Manager for Visual Studio Code</title>
        </head>
        <body>
          <nuget-package-manager></nuget-package-manager>
          <script type="module" nonce="${nonceValue}" src="${webJsSrc}"></script>
        </body>
      </html>
    `;
  }

  private postCommand(command: unknown): void {
    if (!this.panel) {
      this.openPanel();
    }
    // The panel is created in the same tick; give the webview a moment to load
    // its module before delivering a command that depends on the UI.
    setTimeout(() => {
      void this.panel?.webview.postMessage(command);
    }, 300);
  }

  sendSearchQuery(query: string): void {
    this.postCommand({ type: "command", command: "search", query });
  }

  sendNavigateToTab(tab: string): void {
    this.postCommand({ type: "command", command: "navigate-tab", tab });
  }

  sendNavigateToRoute(route: string): void {
    this.postCommand({ type: "command", command: "navigate-route", route });
  }

  sendReloadConfiguration(): void {
    if (!this.panel) return;
    void this.panel.webview.postMessage({ type: "command", command: "reload-configuration" });
  }

  dispose(): void {
    this.panelDisposable?.dispose();
    this.rpcHost?.dispose();
    this.panel?.dispose();
    this.panel = undefined;
    this.rpcHost = undefined;
  }
}

/**
 * Activity-bar launcher. Clicking the icon resolves/reveals this view and opens
 * the full-page editor tab; the launcher remains as a fallback entry point.
 */
class NugetLauncherTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const item = new vscode.TreeItem(
      "Open NuGet Package Manager for Visual Studio Code",
      vscode.TreeItemCollapsibleState.None
    );
    item.command = { command: COMMAND_IDS.open, title: "Open NuGet Package Manager for Visual Studio Code" };
    item.iconPath = new vscode.ThemeIcon("package");
    item.description = "Full-page package workspace";
    return [item];
  }
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info("Extension.deactivate: Extension deactivated");
}
