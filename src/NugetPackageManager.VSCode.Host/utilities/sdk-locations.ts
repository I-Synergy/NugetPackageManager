/**
 * Locations and selection for the `dotnet` hosts available on this machine.
 *
 * The SDK actually used is always the one the project's `global.json` selects;
 * this module only decides which **host executable** runs that resolution (the
 * system install on PATH, or the SDK the extension installed under the user
 * profile) and reports what is installed.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { compareVersions } from "./version";

const DEFAULT_INSTALL_ROOT = path.join(os.homedir(), ".dotnet");

export interface SdkRootsConfig {
    /** Root of SDKs installed by the extension (default `~/.dotnet`). */
    InstallRoot?: string;
}

let config: SdkRootsConfig | null = null;

/** Overrides the install root (tests, or a future setting). */
export function ConfigureSdkRoots(next: SdkRootsConfig | null): void {
    config = next;
}

export function GetSdkInstallRoot(): string {
    return config?.InstallRoot ?? DEFAULT_INSTALL_ROOT;
}

/** Executable of the `dotnet` host installed by the extension, when present. */
export function GetPrivateDotnetPath(): string | undefined {
    const executable = process.platform === "win32" ? "dotnet.exe" : "dotnet";
    const candidate = path.join(GetSdkInstallRoot(), executable);
    return fs.existsSync(candidate) ? candidate : undefined;
}

/** SDK versions present in the extension's install root (`<root>/sdk/<version>`). */
export function GetPrivateSdkVersions(): string[] {
    return ListSdkVersions(GetSdkInstallRoot());
}

export function ListSdkVersions(root: string): string[] {
    try {
        return fs
            .readdirSync(path.join(root, "sdk"), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((a, b) => compareVersions(b, a));
    } catch {
        return [];
    }
}

/** True when `sdk` is exactly `pin` or a patch/minor line below it. */
export function SdkVersionSatisfies(sdk: string, pin: string): boolean {
    return sdk === pin || sdk.startsWith(`${pin}.`) || pin.startsWith(`${sdk}.`);
}

/**
 * The `dotnet` host to run for `pinnedVersion`: the extension's private install
 * when it holds that SDK, otherwise the one on PATH.
 */
export function SelectDotnetCommand(pinnedVersion: string | undefined): string {
    if (!pinnedVersion) return "dotnet";
    const privateDotnet = GetPrivateDotnetPath();
    if (!privateDotnet) return "dotnet";
    return GetPrivateSdkVersions().some((version) => SdkVersionSatisfies(version, pinnedVersion))
        ? privateDotnet
        : "dotnet";
}
