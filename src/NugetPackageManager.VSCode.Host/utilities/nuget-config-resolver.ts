import fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import PasswordScriptExecutor from "./password-script-executor";
import { isPathInside } from "./workspace-path";
import { Logger } from "@/common/logger";
import { getSetting } from "@/common/configuration";
import LocalNuGetFeed from "../nuget/local-feed";
import * as configClient from "../nuget/config-client";

export type SourceWithCredentials = {
  Name: string;
  Url: string;
  Username?: string;
  Password?: string;
  /** `packageSourceMapping` patterns; when present only these packages use this source. */
  Patterns?: string[];
};

/**
 * The VS Code half of NuGet config resolution.
 *
 * Discovery, XML parsing and merging live in the C# core (`resolveNuGetConfig`), which keeps the
 * rule that `%VAR%` expands only in machine- and user-level configs. What stays here is everything
 * the core cannot own: VS Code settings sources, the workspace-trust gate, the machine-scoped
 * script allowlist, password-script execution and local-feed classification.
 */
export default class NuGetConfigResolver {
  static async GetSourcesAndDecodePasswordsAsync(workspaceRoots?: string | string[]): Promise<SourceWithCredentials[]> {
    const roots = this.normalizeRoots(workspaceRoots);
    Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Starting resolution (workspaceRoots: ${roots.join(", ")})`);

    const { sources: sourcesWithCreds, clearFound } = await this.ResolveConfigsAsync(roots);
    const sourcesMap = this.buildSourcesMap(sourcesWithCreds);
    const passwordScriptPaths = this.applyVscodeSources(sourcesMap, clearFound);
    const sources = Array.from(sourcesMap.values());
    const allowlist = getSetting<string[]>("passwordScriptAllowlist", []);
    const trusted = vscode.workspace.isTrusted !== false;

    await this.decodePasswordsAsync(sources, passwordScriptPaths, allowlist, roots, trusted);
    return this.filterSupportedSources(sources);
  }

  private static buildSourcesMap(sourcesWithCreds: SourceWithCredentials[]): Map<string, SourceWithCredentials> {
    const sourcesMap = new Map<string, SourceWithCredentials>();
    sourcesWithCreds.forEach(s => {
      const entry: SourceWithCredentials = { Name: s.Name, Url: s.Url };
      if (s.Username !== undefined) entry.Username = s.Username;
      if (s.Password !== undefined) entry.Password = s.Password;
      if (s.Patterns !== undefined) entry.Patterns = s.Patterns;
      sourcesMap.set(s.Name, entry);
    });
    return sourcesMap;
  }

  private static applyVscodeSources(
    sourcesMap: Map<string, SourceWithCredentials>,
    clearFound: boolean
  ): Map<string, string> {
    const passwordScriptPaths = new Map<string, string>();
    for (const raw of getSetting<string[]>("sources", [])) {
      try {
        const parsed = JSON.parse(raw) as { name?: string; url?: string; passwordScriptPath?: string };
        Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Found source from setting: ${parsed.name}`);
        if (!parsed.name) continue;

        const existingSource = sourcesMap.get(parsed.name);
        if (existingSource) {
          if (parsed.passwordScriptPath) passwordScriptPaths.set(parsed.name, parsed.passwordScriptPath);
        } else if (parsed.url && !clearFound) {
          // When <clear /> was found, respect the intent to restrict sources to what
          // is explicitly declared — don't add extra sources from VS Code settings.
          sourcesMap.set(parsed.name, { Name: parsed.name, Url: parsed.url });
          if (parsed.passwordScriptPath) passwordScriptPaths.set(parsed.name, parsed.passwordScriptPath);
        }
      } catch { /* ignore unparseable source entries */ }
    }
    return passwordScriptPaths;
  }

  private static async decodePasswordsAsync(
    sources: SourceWithCredentials[],
    passwordScriptPaths: Map<string, string>,
    allowlist: string[],
    roots: string[],
    trusted: boolean
  ): Promise<void> {
    for (const source of sources) {
      const passwordScriptPath = passwordScriptPaths.get(source.Name);
      if (!passwordScriptPath || !source.Password) {
        if (source.Username || source.Password) {
          Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Using credentials for ${source.Name}`);
        }
        continue;
      }
      if (!trusted) {
        Logger.warn(`NuGetConfigResolver: Refusing password script for ${source.Name}: workspace is untrusted`);
        continue;
      }
      if (!await this.IsPasswordScriptAllowedAsync(passwordScriptPath, allowlist, roots)) {
        Logger.warn(`NuGetConfigResolver: Refusing password script for ${source.Name}: path is not in the machine-scoped passwordScriptAllowlist`);
        continue;
      }
      try {
        Logger.debug(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Decoding password for ${source.Name}`);
        source.Password = await PasswordScriptExecutor.ExecuteScriptAsync(passwordScriptPath, source.Password);
      } catch (error) {
        Logger.error(`NuGetConfigResolver.GetSourcesAndDecodePasswords: Failed to decode password for ${source.Name}`, error);
      }
    }
  }

  private static filterSupportedSources(sources: SourceWithCredentials[]): SourceWithCredentials[] {
    for (const source of sources) {
      if (!this.IsHttpSource(source.Url) && !LocalNuGetFeed.IsLocalSource(source.Url)) {
        Logger.info(`NuGetConfigResolver: Skipping unsupported source ${source.Name} (${source.Url})`);
      }
    }
    return sources.filter(
      (source) => this.IsHttpSource(source.Url) || LocalNuGetFeed.IsLocalSource(source.Url)
    );
  }

  private static IsHttpSource(url: string): boolean {
    try {
      const protocol = new URL(url).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }

  private static async IsPasswordScriptAllowedAsync(
    scriptPath: string,
    allowlist: string[],
    workspaceRoots: string[]
  ): Promise<boolean> {
    if (allowlist.length === 0) return false;

    const base = workspaceRoots[0] ?? process.cwd();
    const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(base, scriptPath);
    let realScript = resolved;
    try {
      realScript = await fs.promises.realpath(resolved);
    } catch {
      // Keep the resolved path; the executor will report a missing file.
    }

    for (const allowed of allowlist) {
      const resolvedAllowed = path.resolve(allowed);
      let realAllowed = resolvedAllowed;
      try {
        realAllowed = await fs.promises.realpath(resolvedAllowed);
      } catch {
        // Allowlist entries may not exist yet; compare resolved paths.
      }
      if (isPathInside(realAllowed, realScript)) return true;
    }
    return false;
  }

  static async GetSourcesWithCredentialsAsync(workspaceRoots?: string | string[]): Promise<SourceWithCredentials[]> {
    const roots = this.normalizeRoots(workspaceRoots);
    const { sources } = await this.ResolveConfigsAsync(roots);
    return sources;
  }

  private static normalizeRoots(workspaceRoots?: string | string[]): string[] {
    if (Array.isArray(workspaceRoots)) return workspaceRoots;
    return workspaceRoots ? [workspaceRoots] : [];
  }

  private static async ResolveConfigsAsync(workspaceRoots: string[]): Promise<{ sources: SourceWithCredentials[]; clearFound: boolean }> {
    Logger.debug(`NuGetConfigResolver.ResolveConfigs: Starting resolution (workspaceRoots: ${workspaceRoots.join(", ")})`);

    const resolution = await configClient.resolveNuGetConfigAsync(workspaceRoots);

    for (const failure of resolution.Failures) {
      Logger.error(`NuGetConfigResolver.ResolveConfigs: Failed to parse ${failure.Path}: ${failure.Message}`);
    }

    Logger.debug(`NuGetConfigResolver.ResolveConfigs: Resolved ${resolution.Sources.length} source(s)`);
    return { sources: resolution.Sources, clearFound: resolution.ClearFound };
  }
}
