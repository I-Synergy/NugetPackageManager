/**
 * `dotnet sdk check` is the official way to learn whether the installed SDKs and
 * runtimes are up to date or out of support. It has no JSON output — the result
 * is a pair of fixed tables — and it queries release metadata over the network,
 * so callers must cache it and tolerate failure.
 *
 *   .NET SDKs:
 *   Version                      Status
 *   -------------------------------------------------------
 *   10.0.403                     Up to date.
 *
 *   .NET Runtimes:
 *   Name                    Version        Status
 *   -------------------------------------------------------
 *   Microsoft.NETCore.App   10.0.8         Patch 10.0.14 is available.
 */

import { execFile } from "node:child_process";

export interface SdkCheckRow {
    Version: string;
    Status: string;
}

export interface RuntimeCheckRow {
    Name: string;
    Version: string;
    Status: string;
}

export interface SdkCheckResult {
    Sdks: SdkCheckRow[];
    Runtimes: RuntimeCheckRow[];
    /** The command could not run or returned nothing usable. */
    Unavailable: boolean;
    Raw: string;
}

const SDK_TIMEOUT_MS = 25_000;
const SEPARATOR_RE = /^\s*-{4,}\s*$/;

/** Parses the two tables printed by `dotnet sdk check`. */
export function ParseSdkCheckOutput(output: string): SdkCheckResult {
    const sdks: SdkCheckRow[] = [];
    const runtimes: RuntimeCheckRow[] = [];
    let section: SdkCheckSection = "none";

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const nextSection = SectionOf(line);
        if (nextSection !== null) {
            section = nextSection;
            continue;
        }
        if (IsIgnorableLine(line)) continue;
        if (section === "sdks") AddSdkRow(sdks, line);
        if (section === "runtimes") AddRuntimeRow(runtimes, line);
    }

    const usable = sdks.length > 0 || runtimes.length > 0;
    return { Sdks: sdks, Runtimes: runtimes, Unavailable: !usable, Raw: output };
}

type SdkCheckSection = "none" | "sdks" | "runtimes";

/** The section a heading line opens, or `null` when the line is not a heading. */
function SectionOf(line: string): SdkCheckSection | null {
    if (/^\.NET SDKs:/i.test(line)) return "sdks";
    if (/^\.NET Runtimes:/i.test(line)) return "runtimes";
    return null;
}

/** Table furniture: separators and column headers. */
function IsIgnorableLine(line: string): boolean {
    if (SEPARATOR_RE.test(line)) return true;
    if (/^Version\s+Status$/i.test(line)) return true;
    return /^Name\s+Version\s+Status$/i.test(line);
}

function AddSdkRow(sdks: SdkCheckRow[], line: string): void {
    const match = /^(\S+)\s{2,}(\S.*)$/.exec(line);
    if (match?.[1] && match[2]) sdks.push({ Version: match[1], Status: match[2] });
}

function AddRuntimeRow(runtimes: RuntimeCheckRow[], line: string): void {
    const match = /^(\S+)\s+(\S+)\s{2,}(\S.*)$/.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) return;
    runtimes.push({ Name: match[1], Version: match[2], Status: match[3] });
}

export interface SdkCheckOptions {
    Command: string;
    WorkingDirectory: string;
}

/**
 * Runs `dotnet sdk check`. Never throws: an offline machine, a missing SDK or a
 * timeout yields `Unavailable`.
 */
export function RunSdkCheckAsync(options: SdkCheckOptions): Promise<SdkCheckResult> {
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
                    resolve({ Sdks: [], Runtimes: [], Unavailable: true, Raw: error.message });
                    return;
                }
                resolve(ParseSdkCheckOutput(output));
            }
        );
    });
}

/** Status row for a concrete SDK version (falls back to its feature band line). */
export function FindSdkStatus(result: SdkCheckResult, version: string): string | undefined {
    const exact = result.Sdks.find((row) => row.Version === version);
    if (exact) return exact.Status;
    const band = `${version.split(".").slice(0, 2).join(".")}.`;
    return result.Sdks.find((row) => row.Version.startsWith(band))?.Status;
}
