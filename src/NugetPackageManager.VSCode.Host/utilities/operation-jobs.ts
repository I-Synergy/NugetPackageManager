import type {
  AddMissingDefinitionsResponse,
  BatchUpdateResponse,
  CleanupUnusedResponse,
  GetJobResponse,
  GetOutdatedPackagesResponse,
  GetProjectsResponse,
  UpdateProjectResponse,
} from "@/common/rpc/types";
import { JobRegistry } from "./job-registry";

export { JobRegistry };
export type { JobReporter, JobRunner, JobSnapshot } from "./job-registry";

/**
 * Every long-running operation kind, one registry each. The registries hold job
 * state, stage, percent and the terminal `Result`; see `JobRegistry`.
 *
 * Most of these are mutations (batch update, single package update, consolidate,
 * cleanup), but the same polling contract also serves the two scans: a full
 * discovery + parse of a large repository - and the feed walk that follows it -
 * takes as long as a write does, so it must not sit behind a client deadline
 * either.
 */
export class OperationJobs {
  public static readonly Batch = new JobRegistry<BatchUpdateResponse>("batchUpdate");
  public static readonly Project = new JobRegistry<UpdateProjectResponse>("projectUpdate");
  public static readonly Consolidate = new JobRegistry<void>("consolidate");
  public static readonly Cleanup = new JobRegistry<CleanupUnusedResponse>("cleanup");
  public static readonly AddMissingDefinitions = new JobRegistry<AddMissingDefinitionsResponse>("addMissingDefinitions");
  public static readonly Workspace = new JobRegistry<GetProjectsResponse>("workspaceScan");
  public static readonly OutdatedScan = new JobRegistry<GetOutdatedPackagesResponse>("outdatedScan");

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

    const addMissing = OperationJobs.AddMissingDefinitions.Get(jobId);
    if (addMissing) return { Kind: "addMissingDefinitions", ...addMissing };

    const workspace = OperationJobs.Workspace.Get(jobId);
    if (workspace) return { Kind: "workspaceScan", ...workspace };

    const outdatedScan = OperationJobs.OutdatedScan.Get(jobId);
    if (outdatedScan) return { Kind: "outdatedScan", ...outdatedScan };

    return null;
  }

  public static Cancel(jobId: string): boolean {
    return OperationJobs.Batch.Cancel(jobId)
      || OperationJobs.Project.Cancel(jobId)
      || OperationJobs.Consolidate.Cancel(jobId)
      || OperationJobs.Cleanup.Cancel(jobId)
      || OperationJobs.AddMissingDefinitions.Cancel(jobId)
      || OperationJobs.Workspace.Cancel(jobId)
      || OperationJobs.OutdatedScan.Cancel(jobId);
  }

  /** Test seam: abort whatever is running and drop every job of every kind. */
  public static Reset(): void {
    OperationJobs.Batch.Reset();
    OperationJobs.Project.Reset();
    OperationJobs.Consolidate.Reset();
    OperationJobs.Cleanup.Reset();
    OperationJobs.AddMissingDefinitions.Reset();
    OperationJobs.Workspace.Reset();
    OperationJobs.OutdatedScan.Reset();
  }
}
