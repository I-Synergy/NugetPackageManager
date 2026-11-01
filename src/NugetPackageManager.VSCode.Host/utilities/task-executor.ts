import { Mutex } from "async-mutex";
import { spawn } from "node:child_process";
import { Logger } from "@/common/logger";
import {
  ClassifyDotnetFailureAsync,
  type DotnetFailureContext,
} from "./dotnet-failure";
import { ResolveDotnetContext } from "./dotnet-context";
import { DotnetError } from "./dotnet-error";

export { DotnetError };

export interface OperationProgress {
  stage: string;
  percent: number;
}

export interface ExecuteCommandOptions {
  /**
   * Working directory for the child. `dotnet` selects its SDK (and therefore
   * the `global.json` it honours) from this directory, never from the project
   * path passed in `args`.
   */
  cwd?: string;
  /**
   * Executable to run instead of the logical command — e.g. the `dotnet` host
   * installed by the extension rather than the one on PATH.
   */
  command?: string;
  /** Extra facts used to classify a failure into a user-facing cause. */
  failureContext?: DotnetFailureContext;
}

function IsDotnetCommand(command: string): boolean {
  return /(^|[\\/])dotnet(\.exe)?$/i.test(command);
}

/**
 * Options for running `dotnet` against `projectPath`: the SDK context (project
 * pin or workspace override), the executable it selects, the working directory
 * it implies, and the facts needed to classify a failure.
 */
export function CreateDotnetOptions(projectPath: string): ExecuteCommandOptions {
  const context = ResolveDotnetContext(projectPath);
  return {
    cwd: context.WorkingDirectory,
    command: context.Command,
    failureContext: {
      ProjectPath: projectPath,
      ...(context.GlobalJsonPath !== undefined && { GlobalJsonPath: context.GlobalJsonPath }),
      ...(context.PinnedSdkVersion !== undefined && {
        PinnedSdkVersion: context.PinnedSdkVersion,
      }),
    },
  };
}

/** Result of the process phase; classification happens after it settles. */
type ProcessOutcome =
  | { type: "success" }
  | {
      type: "failure";
      message: string;
      output: string;
      /** Present when the failure came from `spawn` itself. */
      context?: DotnetFailureContext;
    };

export class TaskExecutor {
  private readonly globalMutex: Mutex = new Mutex();
  private readonly progress = new Map<string, OperationProgress>();

  async ExecuteCommandAsync(
    command: string,
    args: string[],
    operationId: string,
    signal?: AbortSignal,
    timeoutMs: number = 10 * 60 * 1000,
    onProgress?: (progress: OperationProgress) => void,
    options?: ExecuteCommandOptions
  ): Promise<void> {
    Logger.info(`TaskExecutor.ExecuteCommandAsync: ${command} ${args.join(" ")}`);
    if (signal?.aborted) {
      throw new DotnetError("dotnet operation cancelled", "");
    }

    const starting: OperationProgress = { stage: "Starting...", percent: 5 };
    this.progress.set(operationId, starting);
    onProgress?.(starting);
    const releaser = await this.globalMutex.acquire();

    try {
      if (signal?.aborted) {
        throw new DotnetError("dotnet operation cancelled", "");
      }

      const outcome = await this.RunProcessAsync(
        command,
        args,
        operationId,
        signal,
        timeoutMs,
        onProgress,
        options
      );

      if (outcome.type === "success") {
        Logger.info("TaskExecutor.ExecuteCommandAsync: Completed successfully");
        return;
      }

      const failure = IsDotnetCommand(command)
        ? await ClassifyDotnetFailureAsync(
            outcome.output,
            outcome.context ?? options?.failureContext ?? {}
          )
        : undefined;

      throw new DotnetError(outcome.message, outcome.output, failure);
    } finally {
      releaser();
    }
  }

  GetProgress(operationId: string): OperationProgress | null {
    return this.progress.get(operationId) ?? null;
  }

  private RunProcessAsync(
    command: string,
    args: string[],
    operationId: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onProgress: ((progress: OperationProgress) => void) | undefined,
    options: ExecuteCommandOptions | undefined
  ): Promise<ProcessOutcome> {
    return new Promise<ProcessOutcome>((resolve) => {
      const executable = options?.command ?? command;
      const spawnOptions = options?.cwd
        ? { cwd: options.cwd, windowsHide: true }
        : { windowsHide: true };
      const child = spawn(executable, args, spawnOptions);
      let stdoutBuf = "";
      let stderrBuf = "";
      const allLines: string[] = [];
      let settled = false;
      const state: { timer?: NodeJS.Timeout } = {};

      const cleanup = (): void => {
        if (state.timer) clearTimeout(state.timer);
        signal?.removeEventListener("abort", onAbort);
        this.progress.delete(operationId);
      };

      const finish = (outcome: ProcessOutcome): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const onAbort = (): void => {
        child.kill();
        finish({
          type: "failure",
          message: "dotnet operation cancelled",
          output: allLines.join("\n"),
        });
      };

      const parseLine = (line: string): void => {
        const l = line.toLowerCase().trim();
        if (!l) return;
        allLines.push(line.trim());
        Logger.debug(`TaskExecutor [${operationId}]: ${line.trim()}`);

        let next: OperationProgress | null = null;
        if (l.includes("determining projects") || l.includes("restoring packages for")) {
          next = { stage: "Resolving...", percent: 20 };
        } else if (l.includes("adding packagereference") || l.includes("removing packagereference") || l.includes("installing ")) {
          next = { stage: "Updating project...", percent: 50 };
        } else if (l.includes("writing ") || l.includes("resolving conflicts") || l.includes("assets file")) {
          next = { stage: "Restoring...", percent: 70 };
        } else if (l.includes("restored ") || l.includes("restore completed")) {
          next = { stage: "Finishing...", percent: 95 };
        }
        if (next) {
          this.progress.set(operationId, next);
          onProgress?.(next);
        }
      };

      child.stdout.on("data", (data: Buffer) => {
        stdoutBuf += data.toString();
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        lines.forEach(parseLine);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderrBuf += data.toString();
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        lines.forEach(parseLine);
      });

      child.on("exit", (code) => {
        if (stdoutBuf) parseLine(stdoutBuf);
        if (stderrBuf) parseLine(stderrBuf);
        if (code === 0) {
          finish({ type: "success" });
          return;
        }

        Logger.error(`TaskExecutor.ExecuteCommandAsync: Exited with code ${code}`);
        finish({
          type: "failure",
          message: `dotnet exited with code ${code}`,
          output: allLines.join("\n"),
        });
      });

      child.on("error", (err) => {
        Logger.error(`TaskExecutor.ExecuteCommandAsync: Process error`, err);
        const message = err instanceof Error ? err.message : String(err);
        finish({
          type: "failure",
          message,
          output: message,
          context: { ...options?.failureContext, SpawnFailed: true },
        });
      });

      state.timer = setTimeout(() => {
        child.kill();
        finish({
          type: "failure",
          message: `dotnet timed out after ${timeoutMs}ms`,
          output: allLines.join("\n"),
        });
      }, timeoutMs);

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export default new TaskExecutor();
