/**
 * Probes the .NET toolchain the way this extension will actually use it.
 *
 * `dotnet` picks its SDK from the working directory, so a health check is only
 * meaningful when it runs in the same directory as the real commands: the
 * directory that contains the project's nearest `global.json`. The probe answers
 * four questions for the UI:
 *
 *  - is `dotnet` runnable at all,
 *  - which SDK does it select for this solution, and does that honour the pin,
 *  - which SDKs are installed (for the selector), and
 *  - does an actual `dotnet msbuild -getProperty` evaluation succeed.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
    InstalledSdkInfo,
    ToolchainHealth,
    ToolchainIssue,
} from "@/common/rpc/types";
import type { DotnetContext } from "./dotnet-context";
import {
    FindGlobalJsonUpwards,
    ParseGlobalJson,
    ReadPinnedSdkVersion,
    ResolveDotnetCommand,
    ResolveDotnetContext,
    ResolveWorkingDirectory,
} from "./dotnet-context";
import { ClassifyDotnetFailure, type DotnetFailure } from "./dotnet-failure";
import { FindSdkStatus, RunSdkCheckAsync, type SdkCheckResult } from "./sdk-check";
import { DetectOrphanedManifestBands, GetPrivateSdkVersions, type OrphanedManifestBand } from "./sdk-locations";
import { compareVersions } from "./version";

export interface ToolchainProbeInput {
    WorkspaceRoot: string;
    /** Candidate projects for the smoke evaluation; the first existing one is used. */
    ProjectPaths?: string[];
    /** Used in the diagnostics header. */
    ExtensionVersion?: string;
    /** Bypass the `dotnet sdk check` cache (an explicit Re-check). */
    ForceRefresh?: boolean;
}

interface CommandResult {
    Code: number | null;
    Stdout: string;
    Stderr: string;
    SpawnError?: string;
}

const VERSION_TIMEOUT_MS = 20_000;
const SDK_CHECK_TTL_MS = 10 * 60 * 1000;
const EVALUATION_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_PROJECTS = 20;

function RunCapturedAsync(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
): Promise<CommandResult> {
    return new Promise((resolve) => {
        execFile(
            command,
            args,
            { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (error, stdout, stderr) => {
                if (!error) {
                    resolve({ Code: 0, Stdout: String(stdout ?? ""), Stderr: String(stderr ?? "") });
                    return;
                }
                const errno = error as NodeJS.ErrnoException;
                const spawnError = typeof errno.code === "string" ? errno.code : undefined;
                resolve({
                    Code: typeof errno.code === "number" ? errno.code : null,
                    Stdout: String(stdout ?? ""),
                    Stderr: String(stderr ?? error.message ?? ""),
                    ...(spawnError ? { SpawnError: spawnError } : {}),
                });
            }
        );
    });
}

/** Whether `sdk` is acceptable for `pinned` under `rollForward`. */
export function SdkSatisfiesPin(
    sdk: string,
    pinned: string,
    rollForward: string | undefined
): boolean {
    if (sdk === pinned) return true;
    const roll = (rollForward ?? "latestPatch").toLowerCase();
    if (roll === "disable") return false;
    if (roll === "latestMajor") return true;

    const sdkParts = sdk.split(".");
    const pinParts = pinned.split(".");
    return sdkParts[0] === pinParts[0];
}

/** Parses `dotnet --list-sdks` lines (`10.0.403 [C:\Program Files\dotnet\sdk]`). */
export function ParseSdkList(
    output: string,
    source: InstalledSdkInfo["Source"] = "system"
): InstalledSdkInfo[] {
    const sdks: InstalledSdkInfo[] = [];
    for (const line of output.split(/\r?\n/)) {
        const match = /^(\S+)\s+\[(.+)\]\s*$/.exec(line.trim());
        if (!match?.[1] || !match[2]) continue;
        sdks.push({ Version: match[1], Path: match[2], Source: source });
    }
    return sdks;
}

/** Installed SDKs from the system host plus the extension's private install. */
export function MergeInstalledSdks(
    systemSdks: InstalledSdkInfo[],
    privateVersions: string[]
): InstalledSdkInfo[] {
    const byVersion = new Map<string, InstalledSdkInfo>();
    for (const sdk of systemSdks) byVersion.set(sdk.Version, sdk);
    for (const version of privateVersions) {
        if (!byVersion.has(version)) {
            byVersion.set(version, { Version: version, Path: "~/.dotnet/sdk", Source: "private" });
        }
    }
    // Newest first: versions compare numerically, not as strings (10 > 9).
    return [...byVersion.values()].sort((a, b) => compareVersions(b.Version, a.Version));
}

let sdkCheckCache: { Key: string; ExpiresAt: number; Result: SdkCheckResult } | null = null;

/** `dotnet sdk check` hits the network; cache it per host + working directory. */
async function GetSdkCheckAsync(
    command: string,
    workingDirectory: string,
    forceRefresh: boolean
): Promise<SdkCheckResult> {
    const key = `${command}|${workingDirectory}`;
    if (!forceRefresh && sdkCheckCache?.Key === key && sdkCheckCache.ExpiresAt > Date.now()) {
        return sdkCheckCache.Result;
    }
    const result = await RunSdkCheckAsync({ Command: command, WorkingDirectory: workingDirectory });
    sdkCheckCache = {
        Key: key,
        ExpiresAt: Date.now() + (result.Unavailable ? 60_000 : SDK_CHECK_TTL_MS),
        Result: result,
    };
    return result;
}

export function ResetSdkCheckCacheForTests(): void {
    sdkCheckCache = null;
}

/** Reads one MSBuild property out of `dotnet msbuild -getProperty` JSON output. */
export function ParseMsBuildProperty(output: string, property: string): string | undefined {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
        const parsed = JSON.parse(output.slice(start, end + 1)) as {
            Properties?: Record<string, string>;
        };
        const value = parsed.Properties?.[property]?.trim();
        return value || undefined;
    } catch {
        return undefined;
    }
}

function ReadRollForward(globalJsonPath: string | null): string | undefined {
    if (!globalJsonPath) return undefined;
    try {
        return ParseGlobalJson(fs.readFileSync(globalJsonPath, "utf8"))?.RollForward;
    } catch {
        return undefined;
    }
}

/**
 * Stale `sdk-manifests/<band>` folders are the usual reason a newer SDK cannot
 * compose workloads. They belong to SDKs that are no longer installed and are not
 * cleaned up by `dotnet workload update`.
 */
function DescribeOrphanedBands(orphans: OrphanedManifestBand[]): string {
    const list = orphans.map((orphan) => `${orphan.Band} (${orphan.Path})`).join(", ");
    return (
        ` Left-over workload manifests exist for feature band(s) with no installed SDK: ${list}.` +
        " Neither `dotnet workload update` nor `repair` removes them — delete that folder with administrator rights, or reinstall the SDK that owns it."
    );
}

function FirstExistingProject(projectPaths: string[]): string | null {
    for (const projectPath of projectPaths) {
        if (projectPath && fs.existsSync(projectPath)) return projectPath;
    }
    return null;
}

/** Probes the toolchain for the workspace. No caching; callers own that. */
export async function ProbeToolchainAsync(input: ToolchainProbeInput): Promise<ToolchainHealth> {
    const projectPath = FirstExistingProject(input.ProjectPaths ?? []);
    const context = ResolveProbeContext(projectPath, input.WorkspaceRoot);
    const globalJsonPath = context.GlobalJsonPath ?? FindGlobalJsonUpwards(input.WorkspaceRoot);
    const pinnedSdkVersion = ReadPinnedSdkVersion(globalJsonPath);
    const issues: ToolchainIssue[] = [];

    const versionResult = await RunCapturedAsync(
        context.Command,
        ["--version"],
        context.WorkingDirectory,
        VERSION_TIMEOUT_MS
    );
    const sdkVersion = ReadCommandVersion(versionResult);
    const installedSdks = await ReadInstalledSdksAsync(input.WorkspaceRoot);

    if (!sdkVersion) {
        const failure = ClassifyDotnetFailure(
            [versionResult.Stderr, versionResult.Stdout].filter(Boolean).join("\n"),
            {
                ...(projectPath ? { ProjectPath: projectPath } : {}),
                Context: context,
                SpawnFailed: Boolean(versionResult.SpawnError),
            }
        );
        issues.push(ToToolchainIssue(failure));
        return {
            DotnetFound: !versionResult.SpawnError,
            ...HostFields(globalJsonPath, pinnedSdkVersion, context.Command),
            ProjectEvaluationFailed: false,
            CheckedAt: new Date().toISOString(),
            InstalledSdks: installedSdks,
            Issues: issues,
        };
    }

    const sdkMatchesPin = CheckPinMatch(globalJsonPath, pinnedSdkVersion, sdkVersion, issues);
    const evaluation = await EvaluateProjectAsync(projectPath, sdkVersion, issues);
    const orphanedBands = DetectBands(installedSdks, issues);

    const sdkCheck = await GetSdkCheckAsync(
        context.Command,
        context.WorkingDirectory,
        input.ForceRefresh === true
    );
    const sdkStatus = FindSdkStatus(sdkCheck, sdkVersion);

    return {
        DotnetFound: true,
        SdkVersion: sdkVersion,
        ...(evaluation.BuildSdkVersion ? { BuildSdkVersion: evaluation.BuildSdkVersion } : {}),
        ...(sdkStatus ? { SdkStatus: sdkStatus } : {}),
        SdkCheckUnavailable: sdkCheck.Unavailable,
        ...(orphanedBands.length > 0
            ? { OrphanedManifestBands: orphanedBands.map((band) => band.Path) }
            : {}),
        ...HostFields(globalJsonPath, pinnedSdkVersion, context.Command),
        ...(sdkMatchesPin === undefined ? {} : { SdkMatchesPin: sdkMatchesPin }),
        ProjectEvaluationFailed: evaluation.Failed,
        CheckedAt: new Date().toISOString(),
        InstalledSdks: installedSdks,
        Issues: issues,
    };
}

/** The dotnet host and directory the probe must use, with no project to anchor on. */
function ResolveProbeContext(projectPath: string | null, workspaceRoot: string): DotnetContext {
    if (projectPath) return ResolveDotnetContext(projectPath);
    return {
        WorkingDirectory: ResolveWorkingDirectory(workspaceRoot),
        Command: ResolveDotnetCommand(workspaceRoot),
    };
}

function ReadCommandVersion(result: CommandResult): string | undefined {
    if (result.Code !== 0) return undefined;
    return result.Stdout.trim().split(/\r?\n/)[0]?.trim() || undefined;
}

async function ReadInstalledSdksAsync(workspaceRoot: string): Promise<InstalledSdkInfo[]> {
    const listed = await RunCapturedAsync("dotnet", ["--list-sdks"], workspaceRoot, VERSION_TIMEOUT_MS);
    return MergeInstalledSdks(ParseSdkList(listed.Stdout), GetPrivateSdkVersions());
}

function HostFields(
    globalJsonPath: string | null,
    pinnedSdkVersion: string | undefined,
    command: string
): { GlobalJsonPath?: string; PinnedSdkVersion?: string; DotnetPath?: string } {
    return {
        ...(globalJsonPath ? { GlobalJsonPath: globalJsonPath } : {}),
        ...(pinnedSdkVersion ? { PinnedSdkVersion: pinnedSdkVersion } : {}),
        ...(command === "dotnet" ? {} : { DotnetPath: command }),
    };
}

function ToToolchainIssue(failure: DotnetFailure): ToolchainIssue {
    return {
        Kind: failure.Kind,
        Summary: failure.Summary,
        Hint: failure.Hint,
        Detail: failure.Detail,
    };
}

/** Records a pin mismatch and reports whether the selected SDK satisfies the pin. */
function CheckPinMatch(
    globalJsonPath: string | null,
    pinnedSdkVersion: string | undefined,
    sdkVersion: string,
    issues: ToolchainIssue[]
): boolean | undefined {
    if (!pinnedSdkVersion) return undefined;
    const matches = SdkSatisfiesPin(sdkVersion, pinnedSdkVersion, ReadRollForward(globalJsonPath));
    if (matches) return true;
    issues.push({
        Kind: "SdkPinMismatch",
        Summary: `dotnet selects SDK ${sdkVersion}, but ${globalJsonPath ?? "global.json"} pins ${pinnedSdkVersion}.`,
        Hint: "Pick an installed SDK in the selector (it updates global.json), install the pinned SDK, or relax `sdk.version` / `rollForward`.",
    });
    return false;
}

interface ProjectEvaluation {
    Failed: boolean;
    BuildSdkVersion?: string;
}

/** Runs the real `dotnet msbuild -getProperty` evaluation for one project. */
async function EvaluateProjectAsync(
    projectPath: string | null,
    sdkVersion: string,
    issues: ToolchainIssue[]
): Promise<ProjectEvaluation> {
    if (!projectPath) return { Failed: false };

    const context = ResolveDotnetContext(projectPath);
    const evaluation = await RunCapturedAsync(
        context.Command,
        [
            "msbuild",
            projectPath,
            "-getProperty:TargetFramework",
            "-getProperty:TargetFrameworks",
            "-getProperty:NETCoreSdkVersion",
            "-nologo",
        ],
        context.WorkingDirectory,
        EVALUATION_TIMEOUT_MS
    );

    if (evaluation.Code !== 0) {
        const failure = ClassifyDotnetFailure(
            [evaluation.Stdout, evaluation.Stderr].filter(Boolean).join("\n"),
            { ProjectPath: projectPath, Context: context }
        );
        issues.push(ToToolchainIssue(failure));
        return { Failed: true };
    }

    const buildSdkVersion = ParseMsBuildProperty(evaluation.Stdout, "NETCoreSdkVersion");
    if (!buildSdkVersion || buildSdkVersion === sdkVersion) {
        return { Failed: false, ...(buildSdkVersion ? { BuildSdkVersion: buildSdkVersion } : {}) };
    }

    issues.push({
        Kind: "SdkSelectionMismatch",
        Summary: `dotnet --version reports ${sdkVersion}, but the build resolves SDK ${buildSdkVersion}.`,
        Hint: "The MSBuild value is authoritative. Check the selector and global.json; a nested global.json or MSBuild property can change the SDK per project.",
    });
    return { Failed: false, BuildSdkVersion: buildSdkVersion };
}

/** Left-over manifest bands, with the hint that names them on a workload conflict. */
function DetectBands(installedSdks: InstalledSdkInfo[], issues: ToolchainIssue[]): OrphanedManifestBand[] {
    const systemPath = installedSdks.find((sdk) => sdk.Source === "system")?.Path;
    if (!systemPath) return [];

    const bands = DetectOrphanedManifestBands(
        path.dirname(systemPath),
        installedSdks.map((sdk) => sdk.Version)
    );
    const workloadConflict = issues.find((issue) => issue.Kind === "WorkloadManifestConflict");
    if (workloadConflict && bands.length > 0) {
        workloadConflict.Hint = `${workloadConflict.Hint}${DescribeOrphanedBands(bands)}`;
    }
    return bands;
}

/** Removes obvious credentials before a report leaves the machine. */
export function RedactDiagnostics(text: string): string {
    return text
        .replace(/([?&;](?:password|pwd|token|apikey|api_key|secret)=)[^&;\s]+/gi, "$1***")
        .replace(/\b(password|pwd|token|apikey|api_key|secret)\s*[=:]\s*\S+/gi, "$1=***")
        .replace(/(\/\/)[^/@\s:]+:[^/@\s]+@/g, "$1***@");
}

/**
 * Clipboard-ready diagnostics: the resolved toolchain, the pins, per-project
 * contexts and the last health issues.
 */
function FormatInstalledSdk(sdk: InstalledSdkInfo): string {
    return `${sdk.Version} (${sdk.Source})`;
}

function InstalledSdkSummary(sdks: InstalledSdkInfo[]): string {
    return sdks.map(FormatInstalledSdk).join(", ") || "none";
}

function SdkStatusText(health: ToolchainHealth): string {
    if (health.SdkStatus) return health.SdkStatus;
    if (health.SdkCheckUnavailable) return "unavailable (dotnet sdk check failed)";
    return "unknown";
}

export async function BuildToolchainDiagnosticsAsync(input: ToolchainProbeInput): Promise<string> {
    const projectPaths = (input.ProjectPaths ?? []).filter((projectPath) => fs.existsSync(projectPath));
    const health = await ProbeToolchainAsync(input);
    const command = ResolveDotnetCommand(input.WorkspaceRoot);

    const info = await RunCapturedAsync(command, ["--info"], input.WorkspaceRoot, VERSION_TIMEOUT_MS);
    const sdks = await RunCapturedAsync("dotnet", ["--list-sdks"], input.WorkspaceRoot, VERSION_TIMEOUT_MS);

    const projects = projectPaths.slice(0, MAX_DIAGNOSTIC_PROJECTS).map((projectPath) => {
        const context = ResolveDotnetContext(projectPath);
        const resolved = health.SdkVersion ?? "unknown";
        const pin = context.PinnedSdkVersion ? ` pins ${context.PinnedSdkVersion}` : " (no pins)";
        return `  ${projectPath}\n    cwd: ${context.WorkingDirectory}${pin}\n    sdk: ${resolved}\n    dotnet: ${context.Command}`;
    });

    const issueLines = health.Issues.length > 0
        ? health.Issues.map((issue) => `  [${issue.Kind}] ${issue.Summary}\n    hint: ${issue.Hint}`)
        : ["  none"];

    const globalJsonSection = health.GlobalJsonPath
        ? [`--- global.json (${health.GlobalJsonPath}) ---`, ReadFileSafe(health.GlobalJsonPath)]
        : ["--- global.json ---", "  none found above the workspace root"];

    const report = [
        `--- NuGet Package Manager toolchain diagnostics (${new Date().toISOString()}) ---`,
        `extension: ${input.ExtensionVersion ?? "unknown"}`,
        `workspace: ${input.WorkspaceRoot}`,
        `dotnet found: ${health.DotnetFound}`,
        `dotnet used: ${command}`,
        `selected sdk: ${health.SdkVersion ?? "unknown"}`,
        `pinned sdk: ${health.PinnedSdkVersion ?? "none"}`,
        `build sdk: ${health.BuildSdkVersion ?? "unknown"}`,
        `sdk status: ${SdkStatusText(health)}`,
        `sdk satisfies pin: ${health.SdkMatchesPin === undefined ? "n/a" : health.SdkMatchesPin}`,
        `installed sdks: ${InstalledSdkSummary(health.InstalledSdks)}`,
        `project evaluation failed: ${health.ProjectEvaluationFailed}`,
        "",
        "--- issues ---",
        ...issueLines,
        "",
        ...globalJsonSection,
        "",
        "--- projects ---",
        ...(projects.length > 0 ? projects : ["  none"]),
        "",
        "--- dotnet --list-sdks ---",
        sdks.Stdout.trim() || sdks.Stderr.trim() || "  unavailable",
        "",
        "--- dotnet --info ---",
        info.Stdout.trim() || info.Stderr.trim() || "  unavailable",
        "",
    ].join("\n");

    return RedactDiagnostics(report);
}

function ReadFileSafe(filePath: string): string {
    try {
        return fs.readFileSync(filePath, "utf8").trim();
    } catch {
        return "  unreadable";
    }
}
