import type {
  BatchUpdateResponse,
  CleanupUnusedResponse,
  GetJobResponse,
  UpdateProjectResponse,
} from "@/common/rpc/types";
import { JobRegistry } from "./job-registry";

export { JobRegistry };
export type { JobReporter, JobRunner, JobSnapshot } from "./job-registry";

/**
 * Every long-running mutation kind, one registry each. The registries hold job
 * state, stage, percent and the terminal `Result`; see `JobRegistry`.
 */
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
