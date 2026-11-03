import { CANCELLED_ERROR, fail, ok, type Result } from "@/common/rpc/result";
import type {
  BatchUpdateRequest,
  BatchUpdateResponse,
  CacheControl,
  CleanupUnusedRequest,
  CleanupUnusedResponse,
  ConsolidateRequest,
  GetJobResponse,
  GetOutdatedPackagesRequest,
  GetOutdatedPackagesResponse,
  GetProjectsResponse,
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

/**
 * Runs the workspace scan as a job: the host discovers and parses the whole repository, and reports
 * the core's own per-project progress while it does.
 *
 * A job is what makes a cold parse of a large repository possible: no request deadline applies, and
 * `signal` only stops this view from waiting - the host keeps parsing and caches the result.
 */
export async function runWorkspaceScanJobAsync(
  request: CacheControl,
  options: JobRunOptions = {}
): Promise<Result<GetProjectsResponse>> {
  const started = await startJobAsync(hostApi.startWorkspaceScanAsync(request), options);
  if (!started.ok) return started;

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return status;

  const job = status.value;
  if (job.Kind !== "workspaceScan") return fail(`Unexpected job kind: ${job.Kind}`);
  if (job.State === "cancelled") {
    return fail("The workspace scan was cancelled");
  }
  if (job.State === "completed" && job.Response) return ok(job.Response);
  return fail(job.Error ?? failureMessage(job.State));
}

/**
 * Runs the outdated-package scan as a job.
 *
 * The scan is a discovery + parse plus one metadata walk per installed package, so on a large
 * repository it outlives the RPC deadline and used to come back as "Failed to check for updates"
 * while the host was still working. A job has no client deadline: this view polls stage/percent and
 * reads the response when the job settles.
 *
 * `signal` only stops this view waiting - the host keeps scanning, and the shared run still fills
 * the memo and the scan cache the next caller (or the same view after a refresh) answers from. An
 * aborted signal therefore returns {@link CANCELLED_ERROR} instead of waiting for the scan: every
 * view already treats that text as "the view gave up", never as a scan failure.
 */
export async function runOutdatedScanJobAsync(
  request: GetOutdatedPackagesRequest,
  options: JobRunOptions = {}
): Promise<Result<GetOutdatedPackagesResponse>> {
  const started = await startJobAsync(hostApi.startOutdatedScanAsync(request), options);
  if (!started.ok) return started;
  if (options.signal?.aborted) return fail(CANCELLED_ERROR);

  const status = await waitForJobAsync(started.value, options);
  if (!status.ok) return options.signal?.aborted ? fail(CANCELLED_ERROR) : status;

  const job = status.value;
  if (job.Kind !== "outdatedScan") return fail(`Unexpected job kind: ${job.Kind}`);
  // An explicit cancel (`cancelJobAsync`) is the view's own doing, not a scan failure.
  if (job.State === "cancelled") return fail(CANCELLED_ERROR);
  if (job.State === "completed" && job.Response) return ok(job.Response);
  return fail(job.Error ?? failureMessage(job.State));
}
