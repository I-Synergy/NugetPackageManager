import * as vscode from "vscode";
import { COMMAND_IDS } from "./extension-ids";

/**
 * Activity-bar launcher. Clicking the icon resolves/reveals this view and opens
 * the full-page editor tab; the launcher remains as a fallback entry point.
 */
export class NugetLauncherTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
