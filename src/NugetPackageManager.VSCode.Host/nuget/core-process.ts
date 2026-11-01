import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "@/common/logger";
import { CoreClient, CoreError } from "./core-client";

/**
 * Owns the single C# core process for the extension host.
 *
 * The data lives in `dist/core`; a missing runtime or binary surfaces as a
 * `CoreError` with code `unavailable`, which callers report instead of crashing.
 */
class CoreProcess {
  private client: CoreClient | undefined;
  private dllPath: string | undefined;
  private stderrListener: ((line: string) => void) | undefined;

  public Configure(extensionPath: string): void {
    this.dllPath = path.join(extensionPath, "dist", "core", "NugetPackageManager.Core.dll");
  }

  public SetStderrListener(listener: ((line: string) => void) | undefined): void {
    this.stderrListener = listener;
  }

  public get IsConfigured(): boolean {
    return this.dllPath !== undefined && fs.existsSync(this.dllPath);
  }

  public async CallAsync<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.GetClient().CallAsync<T>(method, params, signal);
  }

  /** Fire-and-forget request whose failure is logged by the client. */
  public Notify(method: string, params: unknown): void {
    if (this.client === undefined) {
      return;
    }

    this.client.Notify(method, params);
  }

  public Dispose(): void {
    this.client?.Dispose();
    this.client = undefined;
  }

  private GetClient(): CoreClient {
    if (this.client !== undefined) {
      return this.client;
    }

    if (this.dllPath === undefined || !fs.existsSync(this.dllPath)) {
      throw new CoreError(
        "unavailable",
        `The .NET core was not found at ${this.dllPath ?? "dist/core"}. Run "npm run build:core".`
      );
    }

    Logger.debug(`CoreProcess: starting the .NET core from ${this.dllPath}`);
    this.client = new CoreClient({
      executable: "dotnet",
      arguments: [this.dllPath],
      ...(this.stderrListener !== undefined && { onStderr: this.stderrListener }),
    });

    return this.client;
  }
}

export default new CoreProcess();
