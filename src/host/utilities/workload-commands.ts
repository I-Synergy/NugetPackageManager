/**
 * Runs `dotnet workload update` / `repair` for the SDK the workspace uses.
 *
 * These commands change the workload manifests of an installed SDK, so they are
 * always user-initiated (confirmation dialog), only run for a trusted workspace,
 * and their output is returned verbatim: on an MSI-based .NET install they often
 * need an elevated terminal, which the UI must be able to say.
 */

import { execFile } from "node:child_process";

export type WorkloadAction = "update" | "repair";

export interface WorkloadCommandResult {
    Action: WorkloadAction;
    Succeeded: boolean;
    ExitCode: number | null;
    Output: string;
    /** The command failed because it needs administrator rights. */
    NeedsElevation: boolean;
}

export interface WorkloadCommandOptions {
    /** `dotnet` host to run (PATH, or the extension's private install). */
    Command: string;
    /** Working directory that selects the SDK band. */
    WorkingDirectory: string;
}

const WORKLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_CHARS = 20_000;

const ELEVATION_RE =
    /access is denied|requires? (?:administrator|elevation|elevated)|run as administrator|请求的操作需要提升|exit code 5\b/i;

/** Trims the captured output and detects an elevation failure. */
export function DescribeWorkloadResult(
    action: WorkloadAction,
    code: number | null,
    output: string
): WorkloadCommandResult {
    const trimmed = output.trim();
    const capped = trimmed.length > MAX_OUTPUT_CHARS
        ? `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n… (output truncated)`
        : trimmed;
    return {
        Action: action,
        Succeeded: code === 0,
        ExitCode: code,
        Output: capped,
        NeedsElevation: code !== 0 && ELEVATION_RE.test(trimmed),
    };
}

export function RunWorkloadCommandAsync(
    action: WorkloadAction,
    options: WorkloadCommandOptions
): Promise<WorkloadCommandResult> {
    return new Promise((resolve) => {
        execFile(
            options.Command,
            ["workload", action],
            {
                cwd: options.WorkingDirectory,
                timeout: WORKLOAD_TIMEOUT_MS,
                maxBuffer: 8 * 1024 * 1024,
                windowsHide: true,
            },
            (error, stdout, stderr) => {
                const output = [stdout, stderr]
                    .filter(Boolean)
                    .join("\n")
                    .trim();
                if (!error) {
                    resolve(DescribeWorkloadResult(action, 0, output));
                    return;
                }
                const errno = error as NodeJS.ErrnoException;
                const code = typeof errno.code === "number" ? errno.code : null;
                const message = code === null && !output ? error.message : "";
                resolve(DescribeWorkloadResult(action, code, [output, message].filter(Boolean).join("\n")));
            }
        );
    });
}
