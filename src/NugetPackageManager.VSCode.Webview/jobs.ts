import { fail, ok, type Result } from "@/common/rpc/result";
import type {
  BatchUpdateRequest,
  BatchUpdateResponse,
  CleanupUnusedRequest,
  CleanupUnusedResponse,
  ConsolidateRequest,
  GetJobResponse,
  JobState,
  StartJobResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
} from "@/common/rpc/types";
import { hostApi } from "@/web/registrations";

/** Poll cadence for a running host job. */
const JOB_POLL_MS = 250;

export type JobProgress = {
  Stage: string;
  Percent: number;
};

export type JobRunOptions = {
  /**
   * Stops this view waiting for the job. The host job keeps running: a closed
   * tab must never abort a package write.
   */
  signal?: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
  /** Receives the host job id so the view can offer an explicit cancel. */
  onStarted?: (jobId: string) => void;
};

function delayAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureMessage(state: JobState): string {
  return state === "cancelled" ? "The operation was cancelled" : `The operation ${state}`;
}

/** Polls a job until it leaves `running`; the caller narrows on `Kind`. */
export async function waitForJobAsync(
  jobId: string,
  options: JobRunOptions = {}
): Promise<Result<GetJobResponse>> {
  for (;;) {
    if (options.signal?.aborted) {
      return fail("The view was closed before the operation finished");
    }

    const status = await hostApi.getJobAsync({ JobId: jobId });
    if (!status.ok) return status;

    options.onProgress?.({ Stage: status.value.Stage, Percent: status.value.Percent });
    if (status.value.State !== "running") return ok(status.value);

    await delayAsync(JOB_POLL_MS);
  }
}

async function startJobAsync(
  started: Promise<Result<StartJobResponse>>,
  options: JobRunOptions
): Promise<Result<string>> {
  const result = await started;
  if (!result.ok) return result;
  options.onStarted?.(result.value.JobId);
  return ok(result.value.JobId);
}

export async function runBatchUpdateJobAsync(
  request: BatchUpdateRequest,
  options: JobRunOptions = {}
): Promise<Result<BatchUpdateResponse>> {
  const started = await startJobAsync(hostApi.startBatchUpdateAsync(request), options);
  if (!started.ok) return started;

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return status;

  const job = status.value;
  if (job.Kind !== "batchUpdate") return fail(`Unexpected job kind: ${job.Kind}`);
  // A cancelled transaction returns `Cancelled: true` with the rolled-back
  // response, so the view can keep the rows and say what happened.
  if (job.Response) return ok(job.Response);
  return fail(job.Error ?? failureMessage(job.State));
}

export async function runProjectUpdateJobAsync(
  request: UpdateProjectRequest,
  options: JobRunOptions = {}
): Promise<Result<UpdateProjectResponse>> {
  const started = await startJobAsync(hostApi.startProjectUpdateAsync(request), options);
  if (!started.ok) return started;

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return status;

  const job = status.value;
  if (job.Kind !== "projectUpdate") return fail(`Unexpected job kind: ${job.Kind}`);
  if (job.State === "cancelled") {
    return fail("The operation was cancelled — the changes it had applied were rolled back");
  }
  if (job.State === "completed" && job.Response) return ok(job.Response);
  return fail(job.Error ?? failureMessage(job.State));
}

export async function runConsolidateJobAsync(
  request: ConsolidateRequest,
  options: JobRunOptions = {}
): Promise<Result<void>> {
  const started = await startJobAsync(hostApi.startConsolidateAsync(request), options);
  if (!started.ok) return started;

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return status;

  const job = status.value;
  if (job.Kind !== "consolidate") return fail(`Unexpected job kind: ${job.Kind}`);
  if (job.State === "cancelled") {
    return fail("The consolidation was cancelled — versions already written were kept");
  }
  return job.State === "completed" ? ok(undefined) : fail(job.Error ?? failureMessage(job.State));
}

export async function runCleanupJobAsync(
  request: CleanupUnusedRequest,
  options: JobRunOptions = {}
): Promise<Result<CleanupUnusedResponse>> {
  const started = await startJobAsync(hostApi.startCleanupAsync(request), options);
  if (!started.ok) return started;

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return status;

  const job = status.value;
  if (job.Kind !== "cleanup") return fail(`Unexpected job kind: ${job.Kind}`);
  if (job.State === "cancelled") {
    return fail("The cleanup was cancelled — packages removed so far stay removed (backups were created)");
  }
  if (job.State === "completed" && job.Response) return ok(job.Response);
  return fail(job.Error ?? failureMessage(job.State));
}
