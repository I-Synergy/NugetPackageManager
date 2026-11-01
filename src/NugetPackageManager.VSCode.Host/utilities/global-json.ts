/**
 * Writes the SDK pin into `global.json` — the file `dotnet` itself reads.
 *
 * The edit and its coherence rules (prerelease, workloadVersion, tools.dotnet) live in the
 * .NET core, which reads, verifies and writes the file. This module is the host adapter: it
 * keeps the official `dotnet new globaljson` template for a workspace that has no file yet (a
 * `dotnet` invocation, which stays in the host) and falls back to the core.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import coreProcess from "@/host/nuget/core-process";
import { FindGlobalJsonUpwards, ParseGlobalJson } from "./dotnet-context";

export interface GlobalJsonUpdateOptions {
    /** Directory to start the upward search for `global.json` from. */
    StartDirectory: string;
    /** Installed SDK version to pin. */
    Version: string;
}

export interface GlobalJsonCreateOptions extends GlobalJsonUpdateOptions {
    /** `dotnet` host used for the official `globaljson` template. */
    Command?: string;
}

export interface GlobalJsonUpdateResult {
    GlobalJsonPath: string;
    /** True when the file did not exist and was created. */
    Created: boolean;
    /** False when the file already pinned this version with a coherent file. */
    Changed: boolean;
    PreviousVersion?: string;
    /** Human-readable list of the other properties that were adjusted. */
    Notes: string[];
    /** `template` = created with `dotnet new globaljson`; `edit` = written by the core. */
    Source?: "template" | "edit";
}

const execFileAsync = promisify(execFile);
const TEMPLATE_TIMEOUT_MS = 60_000;

const SDK_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Accepts only a concrete SDK version (`10.0.403`, `11.0.100-rc.3.26522.148`). */
export function IsValidSdkVersion(version: string): boolean {
    return SDK_VERSION_RE.test(version.trim());
}

/** Pins `options.Version` in the nearest `global.json`, creating one when none exists. */
export async function WriteGlobalJsonSdkVersionAsync(
    options: GlobalJsonUpdateOptions
): Promise<GlobalJsonUpdateResult> {
    const result = await coreProcess.CallAsync<Omit<GlobalJsonUpdateResult, "Source">>(
        "updateGlobalJsonSdkVersion",
        {
            startDirectory: path.resolve(options.StartDirectory),
            version: options.Version.trim(),
        }
    );

    return { ...result, Source: "edit" };
}

/**
 * Creates a missing `global.json` with Microsoft's own template
 * (`dotnet new globaljson --sdk-version <v> --roll-forward disable`) and falls back to the core
 * writer when the template is unavailable or produces something unexpected. An existing file is
 * never handed to the template — it would drop unrelated sections such as `tools` and `test`.
 */
export async function UpdateGlobalJsonSdkVersionAsync(
    options: GlobalJsonCreateOptions
): Promise<GlobalJsonUpdateResult> {
    const startDirectory = path.resolve(options.StartDirectory);
    if (FindGlobalJsonUpwards(startDirectory)) {
        return WriteGlobalJsonSdkVersionAsync(options);
    }

    const created = await TryCreateWithTemplateAsync(
        startDirectory,
        options.Version.trim(),
        options.Command ?? "dotnet"
    );
    return created ?? WriteGlobalJsonSdkVersionAsync(options);
}

async function TryCreateWithTemplateAsync(
    directory: string,
    version: string,
    command: string
): Promise<GlobalJsonUpdateResult | null> {
    if (!IsValidSdkVersion(version)) return null;

    try {
        await execFileAsync(
            command,
            [
                "new",
                "globaljson",
                "--sdk-version",
                version,
                "--roll-forward",
                "disable",
                "--no-update-check",
                "--output",
                directory,
            ],
            { timeout: TEMPLATE_TIMEOUT_MS, windowsHide: true }
        );
    } catch {
        return null;
    }

    const globalJsonPath = path.join(directory, "global.json");
    try {
        const parsed = ParseGlobalJson(fs.readFileSync(globalJsonPath, "utf8"));
        if (parsed?.Version !== version) return null;
    } catch {
        return null;
    }

    return {
        GlobalJsonPath: globalJsonPath,
        Created: true,
        Changed: true,
        Notes: ["created with the official dotnet new globaljson template"],
        Source: "template",
    };
}
