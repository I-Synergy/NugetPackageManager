/**
 * Probes the .NET toolchain the way this extension will actually use it.
 *
 * `dotnet` picks its SDK from the working directory, so a health check is only meaningful when
 * it runs in the same directory as the real commands: the directory that contains the project's
 * nearest `global.json`. The host owns the spawns (progress, cancellation, the private install)
 * and the core turns the captured output into findings.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import type { ToolchainHealth } from "@/common/rpc/types";
import type { DotnetContext } from "./dotnet-context";
import {
    FindGlobalJsonUpwards,
    ReadPinnedSdkVersion,
    ResolveDotnetCommand,
    ResolveDotnetContext,
    ResolveWorkingDirectory,
} from "./dotnet-context";
import { RunSdkCheckAsync } from "./sdk-check";
import { GetPrivateSdkVersions } from "./sdk-locations";
import coreProcess from "@/host/nuget/core-process";

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

/** The wire shape the core's `evaluateToolchain` handler expects. */
interface CommandOutputWire {
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: string;
}

const VERSION_TIMEOUT_MS = 20_000;
const SDK_CHECK_TTL_MS = 10 * 60 * 1000;
const EVALUATION_TIMEOUT_MS = 60_000;
const MAX_DIAGNOSTIC_PROJECTS = 20;

export function RunCapturedAsync(
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

let sdkCheckCache: { Key: string; ExpiresAt: number; Output: string } | null = null;

/** `dotnet sdk check` hits the network; cache its raw output per host + working directory. */
async function GetSdkCheckAsync(
    command: string,
    workingDirectory: string,
    forceRefresh: boolean
): Promise<string> {
    const key = `${command}|${workingDirectory}`;
    if (!forceRefresh && sdkCheckCache?.Key === key && sdkCheckCache.ExpiresAt > Date.now()) {
        return sdkCheckCache.Output;
    }
    const output = await RunSdkCheckAsync({ Command: command, WorkingDirectory: workingDirectory });
    sdkCheckCache = {
        Key: key,
        ExpiresAt: Date.now() + SDK_CHECK_TTL_MS,
        Output: output,
    };
    return output;
}

export function ResetSdkCheckCacheForTests(): void {
    sdkCheckCache = null;
}

/** Probes the toolchain for the workspace. No caching; callers own that. */
export async function ProbeToolchainAsync(input: ToolchainProbeInput): Promise<ToolchainHealth> {
    const projectPath = FirstExistingProject(input.ProjectPaths ?? []);
    const context = ResolveProbeContext(projectPath, input.WorkspaceRoot);
    const globalJsonPath = context.GlobalJsonPath ?? FindGlobalJsonUpwards(input.WorkspaceRoot);
    const pinnedSdkVersion = ReadPinnedSdkVersion(globalJsonPath);

    const versionResult = await RunCapturedAsync(
        context.Command,
        ["--version"],
        context.WorkingDirectory,
        VERSION_TIMEOUT_MS
    );
    const sdkVersion = ReadCommandVersion(versionResult);

    const listed = await RunCapturedAsync("dotnet", ["--list-sdks"], input.WorkspaceRoot, VERSION_TIMEOUT_MS);

    let evaluation: CommandResult | undefined;
    if (sdkVersion && projectPath) {
        const evaluationContext = ResolveDotnetContext(projectPath);
        evaluation = await RunCapturedAsync(
            evaluationContext.Command,
            [
                "msbuild",
                projectPath,
                "-getProperty:TargetFramework",
                "-getProperty:TargetFrameworks",
                "-getProperty:NETCoreSdkVersion",
                "-nologo",
            ],
            evaluationContext.WorkingDirectory,
            EVALUATION_TIMEOUT_MS
        );
    }

    const sdkCheckOutput = sdkVersion
        ? await GetSdkCheckAsync(context.Command, context.WorkingDirectory, input.ForceRefresh === true)
        : undefined;

    return coreProcess.CallAsync<ToolchainHealth>("evaluateToolchain", {
        ...(projectPath ? { projectPath } : {}),
        command: context.Command,
        ...(globalJsonPath ? { globalJsonPath } : {}),
        ...(pinnedSdkVersion ? { pinnedSdkVersion } : {}),
        version: ToWire(versionResult),
        sdkList: ToWire(listed),
        ...(evaluation ? { evaluation: ToWire(evaluation) } : {}),
        ...(sdkCheckOutput !== undefined ? { sdkCheckOutput } : {}),
        privateSdkVersions: GetPrivateSdkVersions(),
        checkedAt: new Date().toISOString(),
    });
}

function ToWire(result: CommandResult): CommandOutputWire {
    return {
        code: result.Code,
        stdout: result.Stdout,
        stderr: result.Stderr,
        ...(result.SpawnError !== undefined && { spawnError: result.SpawnError }),
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

function FirstExistingProject(projectPaths: string[]): string | null {
    for (const projectPath of projectPaths) {
        if (projectPath && fs.existsSync(projectPath)) return projectPath;
    }
    return null;
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
function FormatInstalledSdk(sdk: { Version: string; Source: string }): string {
    return `${sdk.Version} (${sdk.Source})`;
}

function InstalledSdkSummary(sdks: Array<{ Version: string; Source: string }>): string {
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
