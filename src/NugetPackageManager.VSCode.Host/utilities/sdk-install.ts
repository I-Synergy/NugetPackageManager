/**
 * Installs a .NET SDK into the extension's private root using Microsoft's
 * official bootstrap script.
 *
 * This is the only place the extension executes downloaded code. It is reached
 * only from an explicit "Install SDK <version>" action that the user confirms,
 * requires a trusted workspace, accepts only a numeric SDK version, and
 * downloads over HTTPS from `dot.net` (which redirects to Microsoft's CDN).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import axios from "axios";

const SCRIPT_URLS = {
    win32: "https://dot.net/v1/dotnet-install.ps1",
    other: "https://dot.net/v1/dotnet-install.sh",
} as const;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface InstallSdkOptions {
    Version: string;
    /** Root the SDK is installed into (the extension's private host root). */
    InstallRoot: string;
    /** Where the bootstrap script is written before it runs. */
    StagingDirectory: string;
}

export interface InstalledSdk {
    Installed: boolean;
    InstallRoot: string;
    DotnetPath?: string;
    SdkVersion: string;
}

export class SdkInstallError extends Error {
    constructor(message: string, public readonly output: string) {
        super(message);
        this.name = "SdkInstallError";
    }
}

/** Accepts only a concrete SDK version (`10.0.403`, `11.0.100-rc.3.26522.148`). */
export function IsValidSdkVersion(version: string): boolean {
    return VERSION_PATTERN.test(version.trim());
}

function DotnetExecutable(installRoot: string): string {
    return path.join(installRoot, process.platform === "win32" ? "dotnet.exe" : "dotnet");
}

/** True when `<root>/sdk` contains `version` (exact or a matching band). */
export function HasInstalledSdk(installRoot: string, version: string): boolean {
    try {
        return fs
            .readdirSync(path.join(installRoot, "sdk"), { withFileTypes: true })
            .some((entry) => entry.isDirectory() && (entry.name === version || entry.name.startsWith(`${version}.`)));
    } catch {
        return false;
    }
}

async function DownloadScriptAsync(targetPath: string): Promise<void> {
    const url = process.platform === "win32" ? SCRIPT_URLS.win32 : SCRIPT_URLS.other;
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") {
        throw new SdkInstallError("Refusing to download the install script over plain HTTP.", "");
    }

    const response = await axios.get<string>(url, {
        responseType: "text",
        timeout: 120_000,
        maxRedirects: 5,
        transformResponse: [(data: unknown) => data],
    });

    const script = typeof response.data === "string" ? response.data : "";
    // A redirect to an HTML error page must not be executed.
    if (script.length < 1024 || !script.includes("InstallDir")) {
        throw new SdkInstallError("The dotnet-install script could not be downloaded.", "unexpected response");
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, script, { encoding: "utf8", mode: 0o700 });
}

function RunScriptAsync(scriptPath: string, version: string, installRoot: string): Promise<void> {
    const isWindows = process.platform === "win32";
    const command = isWindows ? "powershell.exe" : "bash";
    const args = isWindows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-Version",
            version,
            "-InstallDir",
            installRoot,
            "-NoPath",
        ]
        : [scriptPath, "--version", version, "--install-dir", installRoot, "--no-path"];

    return new Promise((resolve, reject) => {
        execFile(
            command,
            args,
            { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve();
                    return;
                }
                const output = [stdout, stderr].filter(Boolean).join("\n").trim();
                reject(new SdkInstallError(`Installing SDK ${version} failed.`, output));
            }
        );
    });
}

/**
 * Downloads and runs the official `dotnet-install` script, then verifies that
 * the SDK landed in `InstallRoot`.
 */
export async function InstallSdkAsync(options: InstallSdkOptions): Promise<InstalledSdk> {
    const version = options.Version.trim();
    if (!IsValidSdkVersion(version)) {
        throw new SdkInstallError(`"${version}" is not a valid .NET SDK version.`, "");
    }

    const installRoot = path.resolve(options.InstallRoot);
    fs.mkdirSync(installRoot, { recursive: true });

    if (HasInstalledSdk(installRoot, version)) {
        const existingHost = DotnetExecutable(installRoot);
        return {
            Installed: false,
            InstallRoot: installRoot,
            ...(fs.existsSync(existingHost) ? { DotnetPath: existingHost } : {}),
            SdkVersion: version,
        };
    }

    const scriptPath = path.join(
        options.StagingDirectory,
        process.platform === "win32" ? "dotnet-install.ps1" : "dotnet-install.sh"
    );
    await DownloadScriptAsync(scriptPath);

    try {
        await RunScriptAsync(scriptPath, version, installRoot);
    } finally {
        try {
            fs.rmSync(scriptPath, { force: true });
        } catch {
            // A leftover script in the extension's storage folder is harmless.
        }
    }

    if (!HasInstalledSdk(installRoot, version)) {
        throw new SdkInstallError(
            `The installer finished but SDK ${version} is not in ${installRoot}.`,
            ""
        );
    }

    const dotnetPath = DotnetExecutable(installRoot);
    return {
        Installed: true,
        InstallRoot: installRoot,
        ...(fs.existsSync(dotnetPath) ? { DotnetPath: dotnetPath } : {}),
        SdkVersion: version,
    };
}
