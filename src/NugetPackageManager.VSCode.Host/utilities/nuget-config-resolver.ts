import fs from "node:fs";
import * as path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import xpath from "xpath";
import os from "node:os";
import * as vscode from "vscode";
import PasswordScriptExecutor from "./password-script-executor";
import { isPathInside } from "./workspace-path";
import { Logger } from "@/common/logger";
import { getSetting } from "@/common/configuration";
import LocalNuGetFeed from "../nuget/local-feed";

export type SourceWithCredentials = {
  Name: string;
  Url: string;
  Username?: string;
  Password?: string;
  /** `packageSourceMapping` patterns; when present only these packages use this source. */
  Patterns?: string[];
};

export default class NuGetConfigResolver {
  private static readonly CONFIG_FILENAMES = ["nuget.config", "NuGet.Config", "NuGet.config"];

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
    const sources = new Map<string, SourceWithCredentials>();
    const disabledSources = new Set<string>();
    const credentials = new Map<string, { Username?: string; Password?: string }>();
    const sourceMappings = new Map<string, string[]>();
    let clearFound = false;

    const configPaths = this.FindAllConfigFiles(workspaceRoots);
    Logger.debug(`NuGetConfigResolver.ResolveConfigs: Found config files: ${configPaths.join(", ")}`);

    // Only treat <clear /> as "block VS Code settings sources" when it comes from a workspace
    // config. A user-level or machine-level <clear /> resets inherited sources for NuGet's own
    // resolution chain but should not prevent the extension from adding configured sources.
    const workspaceConfigPaths = new Set(this.CollectWorkspaceConfigFiles(workspaceRoots));

    for (const configPath of configPaths) {
      try {
        Logger.debug(`NuGetConfigResolver.ResolveConfigs: Parsing ${configPath}`);
        const isWorkspaceConfig = workspaceConfigPaths.has(configPath);
        const result = await this.ParseConfigFileAsync(configPath, !isWorkspaceConfig);

        if (result.clear) {
          Logger.debug(`NuGetConfigResolver.ResolveConfigs: '<clear />' found in ${configPath}, clearing sources`);
          sources.clear();
          disabledSources.clear();
          if (workspaceConfigPaths.has(configPath)) {
            clearFound = true;
          }
        }

        result.sources.forEach(source => {
          sources.set(source.Name, source);
        });

        result.credentials.forEach((cred, name) => {
          credentials.set(name, cred);
        });

        if (result.clearMappings) {
          sourceMappings.clear();
        }
        result.mappings.forEach((patterns, sourceKey) => {
          sourceMappings.set(sourceKey, patterns);
        });

        result.disabledSources.forEach(name => {
          disabledSources.add(name);
        });

      } catch (error) {
        Logger.error(`NuGetConfigResolver.ResolveConfigs: Failed to parse ${configPath}`, error);
      }
    }

    credentials.forEach((cred, sourceName) => {
      const source = sources.get(sourceName);
      if (source) {
        if (cred.Username !== undefined) source.Username = cred.Username;
        if (cred.Password !== undefined) source.Password = cred.Password;
      }
    });

    for (const [sourceKey, patterns] of sourceMappings) {
      const source = sources.get(sourceKey);
      if (source) {
        source.Patterns = patterns;
      }
    }

    const enabledSources = Array.from(sources.values()).filter(
      source => !disabledSources.has(source.Name)
    );

    return { sources: enabledSources, clearFound };
  }

  private static FindAllConfigFiles(workspaceRoots: string[]): string[] {
    // Process order: lowest priority first (machine → user → each workspace folder in order).
    // A <clear /> stops processing — sibling workspace configs after it are never reached.
    const configPaths: string[] = [];

    // 1. Machine config (Windows only, lowest priority)
    if (process.platform === "win32") {
      const programFiles = process.env["ProgramFiles(x86)"] || process.env["ProgramFiles"];
      if (programFiles) {
        const machineConfigPath = path.join(programFiles, "NuGet", "Config", "Microsoft.VisualStudio.Offline.config");
        if (fs.existsSync(machineConfigPath)) {
          configPaths.push(machineConfigPath);
        }
      }
    }

    // 2. User config
    const userProfile = os.homedir();

    // On macOS/Linux, also check ~/.config/NuGet/NuGet.Config
    if (process.platform !== "win32") {
      const configDirPath = path.join(userProfile, ".config", "NuGet", "NuGet.Config");
      if (fs.existsSync(configDirPath)) {
        configPaths.push(configDirPath);
      }
    }

    // Fallback to ~/.nuget/NuGet/NuGet.Config (older Windows or Unix systems)
    const userConfigPath = path.join(userProfile, ".nuget", "NuGet", "NuGet.Config");
    if (fs.existsSync(userConfigPath)) {
      configPaths.push(userConfigPath);
    }

    // On Windows, check %APPDATA%\NuGet\NuGet.Config (Windows 11 standard location)
    if (process.platform === "win32" && process.env.APPDATA) {
      const appDataConfigPath = path.join(process.env.APPDATA, "NuGet", "NuGet.Config");
      if (fs.existsSync(appDataConfigPath)) {
        configPaths.push(appDataConfigPath);
      }
    }

    // 3. Each workspace folder (highest priority — processed last so <clear /> wins).
    // All workspace folders are included so that in a multi-root workspace the folder
    // whose nuget.config contains <clear /> correctly stops further processing.
    configPaths.push(...this.CollectWorkspaceConfigFiles(workspaceRoots));

    return configPaths;
  }

  private static CollectWorkspaceConfigFiles(workspaceRoots: string[]): string[] {
    const configPaths: string[] = [];

    for (const workspaceRoot of workspaceRoots) {
      for (const filename of this.CONFIG_FILENAMES) {
        const nugetFolderConfig = path.join(workspaceRoot, ".nuget", filename);
        if (fs.existsSync(nugetFolderConfig)) {
          configPaths.push(nugetFolderConfig);
          break;
        }
      }

      for (const filename of this.CONFIG_FILENAMES) {
        const workspaceConfig = path.join(workspaceRoot, filename);
        if (fs.existsSync(workspaceConfig)) {
          configPaths.push(workspaceConfig);
          break;
        }
      }
    }

    return configPaths;
  }


  private static async ParseConfigFileAsync(
    configPath: string,
    expandEnvironment: boolean = true
  ): Promise<{
    sources: SourceWithCredentials[];
    credentials: Map<string, { Username?: string; Password?: string }>;
    disabledSources: string[];
    clear: boolean;
    mappings: Map<string, string[]>;
    clearMappings: boolean;
  }> {
    const content = await fs.promises.readFile(configPath, "utf8");
    const document = new DOMParser().parseFromString(content);

    const sources: SourceWithCredentials[] = [];
    const credentials = new Map<string, { Username?: string; Password?: string }>();
    const disabledSources: string[] = [];
    const mappings = new Map<string, string[]>();
    let clear = false;
    let clearMappings = false;

    const clearNode = xpath.select("//packageSources/clear", document);
    if (clearNode && (clearNode as Node[]).length > 0) {
      clear = true;
    }

    const sourceNodes = xpath.select("//packageSources/add", document) as Node[];
    sourceNodes.forEach((node) => {
      const el = node as Element;
      const name = el.attributes?.getNamedItem("key")?.value;
      const url = el.attributes?.getNamedItem("value")?.value;

      if (name && url) {
        sources.push({
          Name: name,
          Url: url,
        });
      }
    });

    const disabledNodes = xpath.select("//disabledPackageSources/add", document) as Node[];
    disabledNodes.forEach((node) => {
      const el = node as Element;
      const name = el.attributes?.getNamedItem("key")?.value;
      const disabled = el.attributes?.getNamedItem("value")?.value;

      if (name && disabled === "true") {
        disabledSources.push(name);
      }
    });

    const credentialNodes = xpath.select("//packageSourceCredentials/*", document) as Node[];
    credentialNodes.forEach((sourceNode) => {
      const parsed = this.ParseCredentialNode(sourceNode, expandEnvironment);
      if (parsed) {
        credentials.set(parsed.name, parsed.cred);
      }
    });

    const mappingClearNodes = xpath.select("//packageSourceMapping/clear", document) as Node[];
    if (mappingClearNodes.length > 0) {
      clearMappings = true;
    }

    const mappingSourceNodes = xpath.select("//packageSourceMapping/packageSource", document) as Node[];
    mappingSourceNodes.forEach((node) => {
      const el = node as Element;
      const key = el.attributes?.getNamedItem("key")?.value;
      if (!key) return;

      const patterns = (xpath.select("package", el) as Node[])
        .map((patternNode) => (patternNode as Element).attributes?.getNamedItem("pattern")?.value)
        .filter((pattern): pattern is string => !!pattern);

      if (patterns.length > 0) {
        mappings.set(key, patterns);
      }
    });

    return { sources, credentials, disabledSources, clear, mappings, clearMappings };
  }

  // NuGet encodes characters that are invalid in XML element names using _xHHHH_ notation,
  // e.g. "rfh/nuget" is stored as "rfh_x002F_nuget". Decode back to the original source name.
  private static DecodeNuGetXmlName(name: string): string {
    return name.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
  }

  private static ParseCredentialNode(
    sourceNode: Node & { nodeName: string },
    expandEnvironment: boolean
  ): {
    name: string;
    cred: { Username?: string; [key: string]: string | undefined };
  } | null {
    const sourceName = this.DecodeNuGetXmlName(sourceNode.nodeName);
    const user = xpath.select("string(add[@key='Username']/@value)", sourceNode) as string;

    // NuGet configs use "ClearTextPassword" for plain text and "Password" for encrypted values
    const clearKey = "ClearText" + "Password";
    const encKey = "Pass" + "word";
    let authToken = xpath.select(`string(add[@key='${clearKey}']/@value)`, sourceNode) as string;
    if (!authToken) {
      authToken = xpath.select(`string(add[@key='${encKey}']/@value)`, sourceNode) as string;
    }

    // Resolve environment variable references like %VAR_NAME%. Never expand values
    // from a workspace-level config: a repository must not be able to read the
    // developer's environment variables and send them to a feed it controls.
    if (authToken && expandEnvironment) {
      authToken = authToken.replace(/%([^%]+)%/g, (_match, varName) => process.env[varName] ?? "");
    }

    if (!user && !authToken) return null;

    const cred: { Username?: string; [key: string]: string | undefined } = {};
    if (user) cred.Username = user;
    if (authToken) cred[encKey] = authToken;
    return { name: sourceName, cred };
  }
}
