import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Logger } from "@/common/logger";
import { CoreError } from "./core-error";

export { CoreError };

/**
 * Transport for the C# NuGet sidecar.
 *
 * Wire format: one JSON object per line over stdin/stdout (NDJSON). The sidecar
 * announces itself with `{"ready":true,...}` before it accepts work; requests are
 * matched to responses by id; `cancel` aborts an in-flight id.
 *
 * The client owns the process lifecycle: lazy start, bounded restarts, and
 * rejection of every outstanding call when the process dies. It never throws from
 * a notification and never leaves a pending promise unobserved.
 */

export type CoreClientOptions = {
  /** Executable to launch, normally `dotnet`. */
  executable: string;
  /** Arguments for the executable, normally the path to `NugetPackageManager.Core.dll`. */
  arguments: Array<string>;
  /** Environment overrides; used to forward `DOTNET_ROOT`/`PATH` from VS Code. */
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline. Slow feeds are the reason this is generous. */
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  maxRestarts?: number;
  /** Receives the sidecar's stderr, line by line. */
  onStderr?: (line: string) => void;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESTARTS = 3;

/** One progress report the core streamed for an in-flight request. */
export type CoreProgress = {
  stage: string;
  percent: number;
  completed: number;
  total: number;
};

/** Per-call transport tuning; every field is optional and independent of the client defaults. */
export type CoreCallOptions = {
  /** Overall wall-clock cap. Defaults to the client's requestTimeoutMs. */
  timeoutMs?: number;
  /** Rejects when no progress arrives for this long. Only applied when onProgress is set. */
  stallTimeoutMs?: number;
  /** Receives core-side progress for this call. */
  onProgress?: (progress: CoreProgress) => void;
};

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Overall cap for this call. */
  timer: NodeJS.Timeout;
  /** Progress-liveness guard; absent unless the call asked for progress and a stall limit. */
  stallTimer: NodeJS.Timeout | undefined;
  stallTimeoutMs: number | undefined;
  /** The method name, so a stall message can name the call that went quiet. */
  method: string;
  onProgress: ((progress: CoreProgress) => void) | undefined;
  onAbort: (() => void) | undefined;
  signal: AbortSignal | undefined;
};

export class CoreClient {
  private readonly options: CoreClientOptions;
  private readonly requestTimeoutMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly maxRestarts: number;

  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private buffer = "";
  private nextId = 1;
  private restarts = 0;
  private disposed = false;
  private readonly pending = new Map<number, PendingCall>();
  private onReady: (() => void) | undefined;
  private onStartFailure: ((error: Error) => void) | undefined;

  constructor(options: CoreClientOptions) {
    this.options = options;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  }

  /** Sends a request and resolves with its `value`. */
  public async CallAsync<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    options?: CoreCallOptions
  ): Promise<T> {
    if (this.disposed) {
      throw new CoreError("unavailable", "The .NET sidecar client has been disposed.");
    }

    if (signal?.aborted === true) {
      throw new CoreError("cancelled", "The request was cancelled.");
    }

    const child = await this.EnsureStartedAsync();
    const id = this.nextId;
    this.nextId += 1;

    const response = new Promise<T>((resolve, reject) => {
      this.RegisterPending(id, method, signal, options, resolve as (value: unknown) => void, reject);
    });

    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return response;
  }

  /**
   * Fire-and-forget request whose failure is logged, never thrown.
   * Used for cache control, where the caller has no result to wait for.
   */
  public Notify(method: string, params: unknown): void {
    void this.CallAsync<unknown>(method, params).catch((error: unknown) => {
      Logger.debug(`CoreClient.Notify(${method}) failed: ${Describe(error)}`);
    });
  }

  /** True when a sidecar process is running. */
  public get IsRunning(): boolean {
    return this.child !== undefined;
  }

  public Dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.FailPending(new CoreError("unavailable", "The .NET sidecar client has been disposed."));

    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  private RegisterPending(
    id: number,
    method: string,
    signal: AbortSignal | undefined,
    options: CoreCallOptions | undefined,
    resolve: (value: unknown) => void,
    reject: (error: Error) => void
  ): void {
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const onProgress = options?.onProgress;
    // A stall guard only makes sense as a liveness check on progress, so it is ignored for a
    // call that does not ask for progress: that call's only deadline is the overall cap.
    const stallTimeoutMs = onProgress !== undefined ? options?.stallTimeoutMs : undefined;

    const timer = setTimeout(() => {
      this.FailAndCancel(
        id,
        reject,
        new CoreError("timeout", `The .NET sidecar did not answer request ${id} in time.`)
      );
    }, timeoutMs);

    const stallTimer =
      stallTimeoutMs !== undefined
        ? setTimeout(() => {
            this.FailAndCancel(
              id,
              reject,
              new CoreError(
                "timeout",
                `The .NET sidecar stopped reporting progress for ${method} after ${stallTimeoutMs}ms.`
              )
            );
          }, stallTimeoutMs)
        : undefined;

    const onAbort = signal
      ? () => {
          this.RemovePending(id);
          this.Notify("cancel", { target: id });
          reject(new CoreError("cancelled", "The request was cancelled."));
        }
      : undefined;

    if (onAbort && signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    this.pending.set(id, {
      resolve,
      reject,
      timer,
      stallTimer,
      stallTimeoutMs,
      method,
      onProgress,
      onAbort,
      signal,
    });

    // The signal may have fired between the entry check and this registration.
    if (signal?.aborted === true) {
      onAbort?.();
    }
  }

  /**
   * Removes the pending call, tells the sidecar to stop working on it, and rejects it.
   * Used by both deadlines: the overall cap and the progress-stall guard fail the same way.
   */
  private FailAndCancel(id: number, reject: (error: Error) => void, error: CoreError): void {
    if (this.RemovePending(id) === undefined) {
      return;
    }

    this.Notify("cancel", { target: id });
    reject(error);
  }

  /** Restarts the stall deadline; every progress line is proof the sidecar is still working. */
  private RestartStallTimer(id: number, call: PendingCall): void {
    if (call.stallTimeoutMs === undefined) {
      return;
    }

    clearTimeout(call.stallTimer);
    call.stallTimer = setTimeout(() => {
      this.FailAndCancel(
        id,
        call.reject,
        new CoreError(
          "timeout",
          `The .NET sidecar stopped reporting progress for ${call.method} after ${call.stallTimeoutMs}ms.`
        )
      );
    }, call.stallTimeoutMs);
  }

  private RemovePending(id: number): PendingCall | undefined {
    const call = this.pending.get(id);
    if (!call) {
      return undefined;
    }

    this.pending.delete(id);
    clearTimeout(call.timer);
    clearTimeout(call.stallTimer);
    if (call.onAbort && call.signal) {
      call.signal.removeEventListener("abort", call.onAbort);
    }

    return call;
  }

  private FailPending(error: Error): void {
    for (const id of this.pending.keys()) {
      this.RemovePending(id)?.reject(error);
    }
  }

  private async EnsureStartedAsync(): Promise<ChildProcessWithoutNullStreams> {
    if (this.child) {
      return this.child;
    }

    if (this.starting) {
      return this.starting;
    }

    if (this.restarts >= this.maxRestarts) {
      throw new CoreError(
        "unavailable",
        `The .NET sidecar exited ${this.restarts} times without answering; not restarting it again.`
      );
    }

    this.starting = this.StartProcessAsync();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async StartProcessAsync(): Promise<ChildProcessWithoutNullStreams> {
    const child = spawn(this.options.executable, this.options.arguments, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.options.env !== undefined && { env: this.options.env }),
    });

    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A write racing the process exit would otherwise surface as an unhandled
    // stream error; the exit handler rejects the call instead.
    child.stdin.on("error", (error: Error) =>
      Logger.debug(`CoreClient: sidecar stdin failed — ${error.message}`)
    );
    child.stdout.on("data", (chunk: string) => this.HandleStdout(chunk));
    child.stderr.on("data", (chunk: string) => this.HandleStderr(chunk));
    child.on("error", (error) =>
      this.HandleExit(child, new CoreError("unavailable", `Could not start the .NET sidecar: ${error.message}`))
    );
    child.on("exit", (code, signal) =>
      this.HandleExit(
        child,
        new CoreError(
          "crashed",
          `The .NET sidecar exited (code ${code ?? "null"}, signal ${String(signal)}).`
        )
      )
    );

    const ready = new Promise<void>((resolve, reject) => {
      this.onReady = resolve;
      this.onStartFailure = reject;
    });

    const timer = setTimeout(() => {
      this.onStartFailure?.(
        new CoreError("unavailable", "The .NET sidecar did not announce readiness in time.")
      );
    }, this.handshakeTimeoutMs);

    try {
      await ready;
      return child;
    } catch (error) {
      child.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      this.onReady = undefined;
      this.onStartFailure = undefined;
    }
  }

  private HandleExit(child: ChildProcessWithoutNullStreams, error: CoreError): void {
    if (this.child !== child) {
      return;
    }

    this.child = undefined;
    this.restarts += 1;
    this.onStartFailure?.(error);
    this.onStartFailure = undefined;
    this.onReady = undefined;
    this.FailPending(error);
    Logger.debug(`CoreClient: sidecar stopped — ${error.message}`);
  }

  private HandleStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      this.options.onStderr?.(trimmed);
      Logger.debug(`Core sidecar: ${trimmed}`);
    }
  }

  private HandleStdout(chunk: string): void {
    this.buffer += chunk;

    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.HandleLine(line);
      }

      newline = this.buffer.indexOf("\n");
    }
  }

  /**
   * Routes a `type: "progress"` line: progress is a notification, not an answer, so the call
   * stays pending. A progress line for an unknown id (already settled) is dropped.
   */
  private HandleProgress(message: Record<string, unknown>, id: number): void {
    const call = this.pending.get(id);
    if (!call) {
      return;
    }

    // Every progress line proves the sidecar is still working, so the stall deadline restarts.
    this.RestartStallTimer(id, call);
    if (!call.onProgress) {
      return;
    }

    const progress: CoreProgress = {
      stage: ReadString(message["stage"]),
      percent: ReadNumber(message["percent"]),
      completed: ReadNumber(message["completed"]),
      total: ReadNumber(message["total"]),
    };

    try {
      call.onProgress(progress);
    } catch (error) {
      // A listener must never break the read loop for every other in-flight call.
      Logger.warn(`CoreClient: a progress listener for ${call.method} failed: ${Describe(error)}`);
    }
  }

  private HandleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      Logger.warn(`CoreClient: ignoring an unparsable sidecar line: ${line}`);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      return;
    }

    const message = parsed as Record<string, unknown>;
    if (message["ready"] === true) {
      this.onReady?.();
      this.onReady = undefined;
      return;
    }

    const id = message["id"];
    if (typeof id !== "number") {
      return;
    }

    if (message["type"] === "progress") {
      this.HandleProgress(message, id);
      return;
    }

    const call = this.RemovePending(id);
    if (!call) {
      // A late answer for a call that already timed out or was cancelled.
      return;
    }

    if (message["ok"] === true) {
      // A served request proves the process is healthy again.
      this.restarts = 0;
      call.resolve(message["value"]);
      return;
    }

    const detail = message["error"];
    const code =
      typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>)["code"] === "string"
        ? ((detail as Record<string, unknown>)["code"] as string)
        : "protocol";
    const text =
      typeof detail === "object" && detail !== null && typeof (detail as Record<string, unknown>)["message"] === "string"
        ? ((detail as Record<string, unknown>)["message"] as string)
        : "The .NET sidecar reported a failure without a message.";

    call.reject(new CoreError(code, text));
  }
}

function Describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ReadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ReadNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
