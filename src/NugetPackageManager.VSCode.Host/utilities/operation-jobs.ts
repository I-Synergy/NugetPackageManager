import type {
  BatchUpdateResponse,
  CleanupUnusedResponse,
  GetJobResponse,
  JobKind,
  JobState,
  UpdateProjectResponse,
} from "@/common/rpc/types";
import type { Result } from "@/common/rpc/result";
import { Logger } from "@/common/logger";

/**
 * Host-side registry for long mutating operations started with the
 * `start*Async` RPCs.
 *
 * A snapshot/write/restore transaction grows with the repository, not with the
 * request, so it cannot be a request/response call: a client deadline (and the
 * `rpc-cancel` it used to send) could abort healthy work, and a client that
 * waited long enough lost the outcome anyway. Jobs run detached from the
 * request signal; only `cancelJobAsync` aborts one, and the webview polls for
 * stage/percent and the terminal response.
 *
 * Same retention model as `ScanProgress`: recent jobs are kept so a poller can
 * read the terminal response, stale finished jobs are pruned, and a running job
 * is never pruned.
 */

export type JobSnapshot<T> = {
  State: JobState;
  Stage: string;
  Percent: number;
  /** The operation outcome; present once State is not "running". */
  Response?: T;
  /** A failure of the job itself, not of one package. */
  Error?: string;
};

export type JobReporter = (stage: string, percent: number) => void;

export type JobRunner<T> = (signal: AbortSignal, report: JobReporter) => Promise<Result<T>>;

type JobEntry<T> = JobSnapshot<T> & {
  UpdatedAt: number;
  controller: AbortController;
  cancelled: boolean;
  promise: Promise<void>;
};

const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 32;

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export class JobRegistry<T> {
  private readonly entries = new Map<string, JobEntry<T>>();

  public constructor(public readonly Kind: JobKind) {}

  public Start(jobId: string, run: JobRunner<T>): void {
    this.pruneFinishedEntries(Date.now());
    const entry: JobEntry<T> = {
      State: "running",
      Stage: "Starting…",
      Percent: 0,
      UpdatedAt: Date.now(),
      controller: new AbortController(),
      cancelled: false,
      promise: Promise.resolve(),
    };
    this.entries.set(jobId, entry);

    entry.promise = run(entry.controller.signal, (stage, percent) => {
      this.Report(jobId, stage, percent);
    })
      .then((result) => {
        this.Settle(jobId, result);
      })
      .catch((err: unknown) => {
        this.Fail(jobId, err);
      });
  }

  public Report(jobId: string, stage: string, percent: number): void {
    const entry = this.entries.get(jobId);
    if (entry?.State !== "running") return;
    entry.Stage = stage;
    entry.Percent = clampPercent(percent);
    entry.UpdatedAt = Date.now();
  }

  public Get(jobId: string): JobSnapshot<T> | null {
    const entry = this.entries.get(jobId);
    if (!entry) return null;
    return {
      State: entry.State,
      Stage: entry.Stage,
      Percent: entry.Percent,
      ...(entry.Response !== undefined ? { Response: entry.Response } : {}),
      ...(entry.Error ? { Error: entry.Error } : {}),
    };
  }

  /** True when an explicit cancel reached a job that was still running. */
  public Cancel(jobId: string): boolean {
    const entry = this.entries.get(jobId);
    if (entry?.State !== "running") return false;
    entry.cancelled = true;
    entry.Stage = "Cancelling…";
    entry.UpdatedAt = Date.now();
    entry.controller.abort();
    return true;
  }

  public HasRunning(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.State === "running") return true;
    }
    return false;
  }

  /** Test seam: wait for a job's runner to settle. */
  public async WaitAsync(jobId: string): Promise<void> {
    const entry = this.entries.get(jobId);
    if (entry) await entry.promise;
  }

  /** Test seam: abort whatever is running and drop every tracked job. */
  public Reset(): void {
    for (const entry of this.entries.values()) {
      if (entry.State === "running") entry.controller.abort();
    }
    this.entries.clear();
  }

  private pruneFinishedEntries(now: number): void {
    const cutoff = now - MAX_AGE_MS;
    for (const [jobId, entry] of this.entries) {
      if (entry.State !== "running" && entry.UpdatedAt < cutoff) this.entries.delete(jobId);
    }

    if (this.entries.size <= MAX_ENTRIES) return;

    for (const [jobId, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES) break;
      if (entry.State !== "running") this.entries.delete(jobId);
    }
  }

  private Settle(jobId: string, result: Result<T>): void {
    const entry = this.entries.get(jobId);
    if (!entry) return;

    entry.UpdatedAt = Date.now();
    if (result.ok) {
      entry.Response = result.value;
    } else {
      entry.Error = result.error;
    }

    // An explicit cancel wins over the failure its abort produced: the runner
    // reports "rolled back" and the webview should read that as cancelled.
    if (entry.cancelled) {
      entry.State = "cancelled";
      entry.Stage = "Cancelled";
      return;
    }

    if (result.ok) {
      entry.State = "completed";
      entry.Stage = "Completed";
      entry.Percent = 100;
      return;
    }

    entry.State = "failed";
    entry.Stage = "Failed";
    Logger.error(`job ${jobId} (${this.Kind}): ${result.error}`);
  }

  private Fail(jobId: string, err: unknown): void {
    const entry = this.entries.get(jobId);
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(`job ${jobId} (${this.Kind}) threw: ${message}`, err);
    if (!entry) return;
    entry.UpdatedAt = Date.now();
    entry.State = entry.cancelled ? "cancelled" : "failed";
    entry.Error = message;
    entry.Stage = entry.cancelled ? "Cancelled" : "Failed";
  }
}

export class OperationJobs {
  public static readonly Batch = new JobRegistry<BatchUpdateResponse>("batchUpdate");
  public static readonly Project = new JobRegistry<UpdateProjectResponse>("projectUpdate");
  public static readonly Consolidate = new JobRegistry<void>("consolidate");
  public static readonly Cleanup = new JobRegistry<CleanupUnusedResponse>("cleanup");

  /** Finds a job of any kind; the response carries the kind it belongs to. */
  public static Get(jobId: string): GetJobResponse | null {
    const batch = OperationJobs.Batch.Get(jobId);
    if (batch) return { Kind: "batchUpdate", ...batch };

    const project = OperationJobs.Project.Get(jobId);
    if (project) return { Kind: "projectUpdate", ...project };

    const consolidate = OperationJobs.Consolidate.Get(jobId);
    if (consolidate) return { Kind: "consolidate", ...consolidate };

    const cleanup = OperationJobs.Cleanup.Get(jobId);
    if (cleanup) return { Kind: "cleanup", ...cleanup };

    return null;
  }

  public static Cancel(jobId: string): boolean {
    return OperationJobs.Batch.Cancel(jobId)
      || OperationJobs.Project.Cancel(jobId)
      || OperationJobs.Consolidate.Cancel(jobId)
      || OperationJobs.Cleanup.Cancel(jobId);
  }

  /** Test seam: abort whatever is running and drop every job of every kind. */
  public static Reset(): void {
    OperationJobs.Batch.Reset();
    OperationJobs.Project.Reset();
    OperationJobs.Consolidate.Reset();
    OperationJobs.Cleanup.Reset();
  }
}
