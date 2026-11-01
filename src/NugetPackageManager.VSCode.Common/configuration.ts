import * as vscode from "vscode";

/** The extension's configuration namespace. */
export const CONFIG_NS = "nugetpackagemanager";

export const CONFIG_KEYS = [
  "skipRestore",
  "sources",
  "passwordScriptAllowlist",
  "logLevel",
  "enablePackageVersionInlineInfo",
  "prerelease",
  "statusBarLoadingIndicator",
  "enableTelemetry",
  "frameworkAlignedPackages",
  "extraTargetFrameworks",
  "excludeGlobs",
  "updateCheckConcurrency",
] as const;

export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** The configuration section, used for reads and writes. */
export function getConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_NS);
}

/** Reads a setting, falling back to the supplied default. */
export function getSetting<T>(key: ConfigKey, defaultValue: T): T {
  return getConfiguration().get<T>(key) ?? defaultValue;
}

/** Configuration watchers listen to the single current namespace. */
export function isConfigAffected(
  event: vscode.ConfigurationChangeEvent,
  key: ConfigKey
): boolean {
  return event.affectsConfiguration(`${CONFIG_NS}.${key}`);
}
