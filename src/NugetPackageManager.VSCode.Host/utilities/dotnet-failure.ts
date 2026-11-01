/**
 * Classifies the output of a failed `dotnet` invocation into a cause the UI can
 * explain.
 *
 * Restore output is not a single error: a broken SDK resolves to a multi-line
 * MSB4242 stack that looks like a package problem, a NU1107 graph failure names
 * packages, and a missing `global.json` SDK looks like "restore failed". The
 * classifier keeps the raw text but adds a kind, a one-line summary and a hint
 * that matches the kind, so callers never have to show the stack.
 */

import type { DotnetFailureInfo } from "@/common/rpc/types";
import { StripTrailingPunctuation } from "@/common/text";
import type { DotnetContext } from "./dotnet-context";
import {
    ParseRestoreConflicts,
    SummarizeRestoreFailure,
    type RestoreConflict,
} from "./restore-diagnostics";

export type { DotnetFailureKind } from "@/common/rpc/types";

/** Host-side failure record: the wire shape plus the parsed conflict chains. */
export interface DotnetFailure extends Omit<DotnetFailureInfo, "Conflicts"> {
    Conflicts: RestoreConflict[];
}

export interface DotnetFailureContext {
    ProjectPath?: string;
    /** Resolution context for the project, when the caller has it. */
    Context?: DotnetContext;
    /** `spawn` itself failed, e.g. `ENOENT` for a missing CLI. */
    SpawnFailed?: boolean;
}

const MAX_DETAIL_LINES = 60;
const WORKLOAD_CONFLICT_RE = /WorkloadManifestCompositionException|Workload pack '[^']+' in manifest '[^']+' conflicts/i;
const SDK_RESOLUTION_RE = /\bMSB4242\b|SDK Resolver Failure/i;
const PINNED_SDK_MISSING_RE =
    /\bMSB4236\b|The SDK '([^']+)' specified could not be found|A compatible \.NET SDK .* was not found/i;
const VULNERABILITY_AUDIT_RE = /NU190[0-5]/i;
const VULNERABLE_PACKAGE_RE = /Package '([^']+)' ([^\s]+) has a known (\w+) severity vulnerability,?\s*(https?:\/\/\S+)?/gi;
const SOURCE_UNAVAILABLE_RE =
    /\bNU1301\b|\bNU1801\b|Unable to load the service index|No such host is known|ECONNREFUSED|ETIMEDOUT|407 Proxy Authentication/i;
const PASSWORD_SCRIPT_RE = /password script|credential provider .*failed/i;
const DOTNET_MISSING_RE = /ENOENT|not recognized as an internal or external command|command not found|No such file or directory/i;

/** `10.0.403` or `11.0.100-rc.3.26522.148`: digits, dots and an optional suffix. */
function IsSdkVersionSegment(value: string): boolean {
    let dots = 0;
    let digits = 0;
    for (const char of value) {
        const isDigit = char >= "0" && char <= "9";
        const isLetter = (char >= "a" && char <= "z") || (char >= "A" && char <= "Z");
        if (isDigit) {
            digits += 1;
        } else if (char === ".") {
            dots += 1;
        } else if (!isLetter && char !== "-" && char !== "_") {
            return false;
        }
    }
    return digits > 0 && dots >= 2;
}

function extractSdkVersion(output: string): string | undefined {
    // MSBuild paths mix separators; split them instead of backtracking over them.
    const segments = output.replace(/\\/g, "/").split("/");
    for (let index = 0; index < segments.length - 1; index++) {
        if ((segments[index] ?? "").toLowerCase() !== "sdk") continue;
        const candidate = segments[index + 1] ?? "";
        if (IsSdkVersionSegment(candidate)) return candidate;
    }
    return undefined;
}

function extractConflictingPack(output: string): string | undefined {
    const match = /Workload pack '([^']+)' in manifest '([^']+)'/i.exec(output);
    if (!match) return undefined;
    return `${match[1]} (${match[2]})`;
}

function errorLines(output: string): string[] {
    const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\berror\s+[A-Z]+\d+/i.test(line))
        .map((line) => line.replace(/^.*?\s:\s(?=error\s)/i, ""));
    return [...new Set(lines)];
}

function detailFrom(output: string): string {
    const errors = errorLines(output);
    const source = errors.length > 0 ? errors : output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return source.slice(0, MAX_DETAIL_LINES).join("\n");
}

function pinnedSuffix(pinned: string | undefined): string {
    return pinned ? ` This solution pins SDK ${pinned} in global.json.` : "";
}

/**
 * Builds the failure record for `output`. `context` supplies the project path
 * and the SDK pinned by the project's `global.json`, if any.
 */
type FailureBase = Omit<DotnetFailure, "Kind" | "Summary" | "Hint">;

export function ClassifyDotnetFailure(
    output: string,
    context: DotnetFailureContext = {}
): DotnetFailure {
    const base = BuildFailureBase(output, context);
    return (
        ClassifySdkFailure(output, base, context) ??
        ClassifyVulnerabilityAudit(output, base) ??
        ClassifyRestoreFailure(output, base) ??
        ClassifyEnvironmentFailure(output, base) ??
        UnknownFailure(output, base)
    );
}

function BuildFailureBase(output: string, context: DotnetFailureContext): FailureBase {
    const projectPath = context.ProjectPath;
    const pinned = context.Context?.PinnedSdkVersion;
    const globalJsonPath = context.Context?.GlobalJsonPath;
    const sdkVersion = extractSdkVersion(output);
    return {
        Detail: detailFrom(output),
        Conflicts: ParseRestoreConflicts(output),
        ...(sdkVersion ? { SdkVersion: sdkVersion } : {}),
        ...(globalJsonPath ? { GlobalJsonPath: globalJsonPath } : {}),
        ...(pinned ? { PinnedSdkVersion: pinned } : {}),
        ...(projectPath ? { ProjectPath: projectPath } : {}),
    };
}

/** SDK-level causes, in the order they must be recognised. */
function ClassifySdkFailure(
    output: string,
    base: FailureBase,
    context: DotnetFailureContext
): DotnetFailure | null {
    const pinned = context.Context?.PinnedSdkVersion;
    const sdkLabel = base.SdkVersion ? ` ${base.SdkVersion}` : "";

    if (context.SpawnFailed || (DOTNET_MISSING_RE.test(output) && !SDK_RESOLUTION_RE.test(output))) {
        return {
            ...base,
            Kind: "DotnetMissing",
            Summary: "The dotnet CLI could not be started.",
            Hint: "Install the .NET SDK and make sure `dotnet` is on PATH, then reload the window.",
        };
    }

    if (WORKLOAD_CONFLICT_RE.test(output)) {
        const pack = extractConflictingPack(output);
        const packLabel = pack ? ` (${pack})` : "";
        return {
            ...base,
            Kind: "WorkloadManifestConflict",
            Summary: `The .NET SDK${sdkLabel} on this machine has conflicting workload manifests${packLabel}.`,
            Hint: `This is a machine-level .NET SDK problem, not a package problem.${pinnedSuffix(pinned)} Use "Update workloads" on the Toolchain tab (or run \`dotnet workload update\` in an elevated terminal); if it persists, repair or remove that SDK.`,
        };
    }

    if (SDK_RESOLUTION_RE.test(output)) {
        return {
            ...base,
            Kind: "SdkResolutionFailure",
            Summary: `The .NET SDK${sdkLabel} could not resolve its SDK components.`,
            Hint: `Run \`dotnet workload repair\` or reinstall the SDK used by this solution.${pinnedSuffix(pinned)}`,
        };
    }

    const missingPinned = PINNED_SDK_MISSING_RE.exec(output);
    if (!missingPinned) return null;
    const version = missingPinned[1] ?? pinned;
    const versionLabel = version ? ` ${version}` : "";
    return {
        ...base,
        Kind: "PinnedSdkMissing",
        Summary: `The .NET SDK${versionLabel} required by global.json is not installed.`,
        Hint: "Install that SDK version, or update `sdk.version` in global.json to one that is installed.",
    };
}

function ClassifyVulnerabilityAudit(output: string, base: FailureBase): DotnetFailure | null {
    if (!VULNERABILITY_AUDIT_RE.test(output)) return null;

    const packages: string[] = [];
    const advisories: string[] = [];
    for (const match of output.matchAll(VULNERABLE_PACKAGE_RE)) {
        packages.push(`${match[1]} ${match[2]} (${match[3]})`);
        if (match[4]) advisories.push(StripTrailingPunctuation(match[4]));
    }
    const listed = [...new Set(packages)].slice(0, 5).join(", ");
    const advisory = [...new Set(advisories)][0];
    const listedSuffix = listed ? `: ${listed}` : "";
    const advisorySuffix = advisory ? `. Advisory: ${advisory}` : "";

    return {
        ...base,
        Kind: "VulnerabilityAudit",
        Summary: `The vulnerability audit fails the build${listedSuffix}.`,
        Hint: `NuGetAudit is enabled and NU190x is promoted to an error by WarningsAsErrors. Update the affected package (as a transitive dependency, raise the direct parent or add a central pin to a patched version), or stop promoting NU190x${advisorySuffix}.`,
    };
}

function ClassifyRestoreFailure(output: string, base: FailureBase): DotnetFailure | null {
    if (base.Conflicts.length === 0) return null;
    return {
        ...base,
        Kind: "RestoreConflict",
        Summary: SummarizeRestoreFailure(output) ?? "Package restore failed with a dependency conflict.",
        Hint: "Pin the contested package to a single version (the Consolidate tab can do this) and restore again.",
    };
}

/** Feed and credential causes: the restore never reached package resolution. */
function ClassifyEnvironmentFailure(output: string, base: FailureBase): DotnetFailure | null {
    if (SOURCE_UNAVAILABLE_RE.test(output)) {
        return {
            ...base,
            Kind: "SourceUnavailable",
            Summary: "A NuGet source could not be reached.",
            Hint: "Check the source URL, network/proxy settings and feed credentials, then restore again.",
        };
    }
    if (!PASSWORD_SCRIPT_RE.test(output)) return null;
    return {
        ...base,
        Kind: "PasswordScriptFailed",
        Summary: "The password script did not supply a usable credential.",
        Hint: "Run the script manually, check that the allowlist path is correct, and confirm it prints the password to stdout.",
    };
}

function UnknownFailure(output: string, base: FailureBase): DotnetFailure {
    return {
        ...base,
        Kind: "Unknown",
        Summary: SummarizeRestoreFailure(output) ?? "dotnet failed without a recognizable error.",
        Hint: "Open the NuGet Package Manager output channel for the full command output.",
    };
}

/** One-line log/debug form. */
export function DescribeDotnetFailure(failure: DotnetFailure): string {
    const project = failure.ProjectPath ? ` [${failure.ProjectPath}]` : "";
    return `${failure.Kind}: ${failure.Summary}${project} — ${failure.Hint}`;
}

/** Drops host-only fields so the failure can cross the RPC boundary. */
export function ToFailureInfo(failure: DotnetFailure): DotnetFailureInfo {
    const conflicts = failure.Conflicts.map((conflict) => ({
        Code: conflict.code,
        PackageId: conflict.packageId,
        ...(conflict.suggestedVersion ? { SuggestedVersion: conflict.suggestedVersion } : {}),
        Message: conflict.message,
        Chains: conflict.constraints.map((constraint) => constraint.chain),
    }));
    return {
        Kind: failure.Kind,
        Summary: failure.Summary,
        Hint: failure.Hint,
        Detail: failure.Detail,
        ...(conflicts.length > 0 ? { Conflicts: conflicts } : {}),
        ...(failure.SdkVersion ? { SdkVersion: failure.SdkVersion } : {}),
        ...(failure.GlobalJsonPath ? { GlobalJsonPath: failure.GlobalJsonPath } : {}),
        ...(failure.PinnedSdkVersion ? { PinnedSdkVersion: failure.PinnedSdkVersion } : {}),
        ...(failure.ProjectPath ? { ProjectPath: failure.ProjectPath } : {}),
    };
}
