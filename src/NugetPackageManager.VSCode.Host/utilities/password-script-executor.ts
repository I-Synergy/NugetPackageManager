import * as vscode from "vscode";
import { spawn } from "node:child_process";
import { Logger } from "@/common/logger";
import { PasswordScriptTerminal } from "./password-script-terminal";

export default class PasswordScriptExecutor {
  private static readonly cache: Map<string, { password: string; timestamp: number }> = new Map();
  private static readonly pendingExecutions: Map<string, Promise<string>> = new Map();
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // START: Test Hook
  // Exposed for testing purposes to mock child_process.spawn
  // eslint-disable-next-line sonarjs/public-static-readonly -- writable test hook
  public static _spawn = spawn; // NOSONAR: writable test hook
  // END: Test Hook

  static async ExecuteScriptAsync(scriptPath: string, encodedPassword: string): Promise<string> {
    if (!encodedPassword || encodedPassword.trim() === '') {
      throw new Error('Encoded password is empty or undefined');
    }

    const cacheKey = `${scriptPath}:${encodedPassword}`;
    
    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.password;
    }

    // Check if there's already a pending execution for this key
    const pendingExecution = this.pendingExecutions.get(cacheKey);
    if (pendingExecution) {
      return pendingExecution;
    }

    // Create and store the pending execution promise
    const executionPromise = this.executeScriptInternalAsync(scriptPath, encodedPassword, cacheKey);
    this.pendingExecutions.set(cacheKey, executionPromise);

    try {
      return await executionPromise;
    } finally {
      // Clean up the pending execution regardless of success/failure
      this.pendingExecutions.delete(cacheKey);
    }
  }

  private static async executeScriptInternalAsync(scriptPath: string, encodedPassword: string, cacheKey: string): Promise<string> {
    try {
      const pty = new PasswordScriptTerminal(scriptPath, encodedPassword, this._spawn);
      
      const terminal = vscode.window.createTerminal({
        name: 'NuGet Password Script',
        pty,
      });

      const decodedPassword = await new Promise<string>((resolve, reject) => {
        pty.onDidClose((exitCode) => {
          terminal.dispose();
          
          if (exitCode !== 0) {
            const errorMsg = pty.getErrorOutput();
            reject(new Error(`Script exited with code ${exitCode}${errorMsg ? ': ' + errorMsg : ''}`));
            return;
          }

          const output = pty.getOutput();
          if (!output) {
            reject(new Error('Password script returned empty output'));
            return;
          }

          resolve(output);
        });
      });
      
      this.cache.set(cacheKey, {
        password: decodedPassword,
        timestamp: Date.now(),
      });

      return decodedPassword;
    } catch (error: unknown) {
      Logger.error(`PasswordScriptExecutor.ExecuteScript: Failed to execute password script ${scriptPath}`, error);
      const err = error as { message?: string };
      throw new Error(`Password script execution failed: ${err.message || String(error)}`);
    }
  }

  static ClearCache(): void {
    this.cache.clear();
    this.pendingExecutions.clear();
  }

  static ClearExpiredCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp >= this.CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}
