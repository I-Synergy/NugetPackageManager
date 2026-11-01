/**
 * Runs `dotnet sdk check` — the official way to learn whether the installed SDKs and runtimes
 * are up to date. It has no JSON output and queries release metadata over the network, so the
 * host caches the raw text (keyed by host + working directory) and the core parses it.
 */

import { execFile } from "node:child_process";

export interface SdkCheckOptions {
    Command: string;
    WorkingDirectory: string;
}

const SDK_TIMEOUT_MS = 25_000;

/** Runs the command. Never throws: a timeout or spawn failure yields the error text. */
export function RunSdkCheckAsync(options: SdkCheckOptions): Promise<string> {
    return new Promise((resolve) => {
        execFile(
            options.Command,
            ["sdk", "check"],
            {
                cwd: options.WorkingDirectory,
                timeout: SDK_TIMEOUT_MS,
                maxBuffer: 4 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                const output = [stdout, stderr].filter(Boolean).join("\n");
                if (error && !output.trim()) {
                    resolve(error.message);
                    return;
                }
                resolve(output);
            }
        );
    });
}
