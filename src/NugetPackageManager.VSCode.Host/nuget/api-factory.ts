import * as vscode from "vscode";
import { Logger } from "@/common/logger";
import NuGetConfigResolver from "../utilities/nuget-config-resolver";
import PasswordScriptExecutor from "../utilities/password-script-executor";
import SidecarSourceApi from "./sidecar-source-api";
import type { INuGetSourceApi } from "./source-api";

class NuGetApiFactory {
  private readonly _sourceApiCollection = new Map<string, INuGetSourceApi>();

  public async GetSourceApiAsync(url: string): Promise<INuGetSourceApi> {
    const cached = this._sourceApiCollection.get(url);
    if (cached) {
      Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Returning cached API instance for ${url}`);
      return cached;
    }

    Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Creating new API instance for ${url}`);
    const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

    const sourceSummary = sources
      .map(s => `${s.Name}=${s.Url} (hasAuth=${!!s.Username || !!s.Password})`)
      .join(", ");
    Logger.debug(`NuGetApiFactory.GetSourceApiAsync: Available sources: ${sourceSummary}`);

    // Match by URL with/without trailing slash normalization
    const normalizeUrl = (u: string) => {
      let end = u.length;
      while (end > 0 && u[end - 1] === "/") end--;
      return u.slice(0, end).toLowerCase();
    };
    const sourceWithCreds = sources.find(s => normalizeUrl(s.Url) === normalizeUrl(url));

    const hasAuth = !!(sourceWithCreds?.Username || sourceWithCreds?.Password);
    if (hasAuth) {
      Logger.info(`NuGetApiFactory.GetSourceApiAsync: Using credentials for ${url} (user: ${sourceWithCreds?.Username})`);
    } else {
      Logger.warn(`NuGetApiFactory.GetSourceApiAsync: No credentials found for ${url}. Available source URLs: [${sources.map(s => s.Url).join(", ")}]`);
    }

    const api = new SidecarSourceApi(
      url,
      sourceWithCreds?.Username,
      sourceWithCreds?.Password,
      ReadProxyUrl()
    );
    this._sourceApiCollection.set(url, api);
    return api;
  }

  public ClearCache(clearHttpCache = false) {
    for (const api of this._sourceApiCollection.values()) {
      api.ClearPackageCache();
      if (clearHttpCache) api.ClearHttpCache();
    }
    this._sourceApiCollection.clear();
    PasswordScriptExecutor.ClearCache();
  }
}

/**
 * Proxy from VS Code's `http.proxy`, falling back to the environment. Read here rather
 * than in the core: it is a host setting, and the sidecar must not pick its own network path.
 */
function ReadProxyUrl(): string | undefined {
  const configured = vscode.workspace.getConfiguration().get<string>("http.proxy");
  if (configured !== undefined && configured !== "") {
    return configured;
  }

  return (
    process.env["HTTPS_PROXY"] ??
    process.env["https_proxy"] ??
    process.env["HTTP_PROXY"] ??
    process.env["http_proxy"]
  );
}

export default new NuGetApiFactory();
