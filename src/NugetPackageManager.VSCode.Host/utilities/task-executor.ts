import { Mutex } from "async-mutex";
import { spawn } from "node:child_process";
import { Logger } from "@/common/logger";
import { ClassifyDotnetFailure, type DotnetFailure, type DotnetFailureContext } from "./dotnet-failure";
import { ResolveDotnetContext } from "./dotnet-context";

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

export class DotnetError extends Error {
  constructor(
    message: string,
    public readonly output: string,
    public readonly failure?: DotnetFailure
  ) {
    super(message);
    this.name = "DotnetError";
  }
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
    failureContext: { ProjectPath: projectPath, Context: context },
  };
}

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

      await new Promise<void>((resolve, reject) => {
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

        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) reject(error);
          else resolve();
        };

        const onAbort = (): void => {
          child.kill();
          finish(new DotnetError("dotnet operation cancelled", allLines.join("\n")));
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
            Logger.info(`TaskExecutor.ExecuteCommandAsync: Completed successfully`);
            finish();
          } else {
            Logger.error(`TaskExecutor.ExecuteCommandAsync: Exited with code ${code}`);
            const output = allLines.join("\n");
            const failure = IsDotnetCommand(command)
              ? ClassifyDotnetFailure(output, options?.failureContext)
              : undefined;
            finish(new DotnetError(`dotnet exited with code ${code}`, output, failure));
          }
        });

        child.on("error", (err) => {
          Logger.error(`TaskExecutor.ExecuteCommandAsync: Process error`, err);
          const message = err instanceof Error ? err.message : String(err);
          const failure = IsDotnetCommand(command)
            ? ClassifyDotnetFailure(message, { ...options?.failureContext, SpawnFailed: true })
            : undefined;
          finish(new DotnetError(message, message, failure));
        });

        state.timer = setTimeout(() => {
          child.kill();
          finish(new DotnetError(`dotnet timed out after ${timeoutMs}ms`, allLines.join("\n")));
        }, timeoutMs);

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } finally {
      releaser();
    }
  }

  GetProgress(operationId: string): OperationProgress | null {
    return this.progress.get(operationId) ?? null;
  }
}

export default new TaskExecutor();
