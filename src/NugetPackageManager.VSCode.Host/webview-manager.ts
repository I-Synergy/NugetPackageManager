import * as vscode from "vscode";
import nonce from "@/common/nonce";
import { RpcHost } from "@/common/rpc/rpc-host";
import { createHostAPI } from "./host-api";
import nugetApiFactory from "./nuget/api-factory";
import { PANEL_ID } from "./extension-ids";

/**
 * Owns the single full-page NuGet editor tab and its RPC host.
 * The tab survives focus changes, is restored after a window reload, and is
 * revealed (rather than duplicated) when a command asks for it again.
 */
export class NugetWebviewManager implements vscode.Disposable {
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
