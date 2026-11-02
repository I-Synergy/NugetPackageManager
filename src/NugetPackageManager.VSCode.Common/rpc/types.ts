import type { Result } from "./result";

// ============================================================
// Domain Types (re-exported from common/types.ts)
// ============================================================

// These are defined globally in common/types.ts and referenced here
// for type-safety in the HostAPI interface. The actual domain types
// (Package, Project, Configuration, etc.) remain in common/types.ts.

// ============================================================
// Reusable Request Building Blocks
// ============================================================

export type SourceContext = {
  Url: string;
  SourceName?: string;
  PasswordScriptPath?: string;
};

export type PaginationParams = {
  Skip: number;
  Take: number;
};

export type CacheControl = {
  ForceReload?: boolean;
};

// ============================================================
// Request Types
// ============================================================

export type GetPackagesRequest = SourceContext &
  PaginationParams &
  CacheControl & {
    Filter: string;
    Prerelease: boolean;
    Sort?: "relevance" | "downloads" | "recent" | "name-asc";
  };

export type GetPackageRequest = SourceContext &
  CacheControl & {
    Id: string;
    Prerelease: boolean;
  };

export type GetPackageDetailsRequest = SourceContext & {
  /** Package id and exact version: NuGet.Protocol addresses metadata this way, not by leaf URL. */
  Id: string;
  Version: string;
};

export type GetPackageFrameworksRequest = SourceContext & {
  /** Package id and exact version whose assets decide the supported frameworks. */
  Id: string;
  Version: string;
};

export type GetOutdatedPackagesRequest = CacheControl & {
  Prerelease: boolean;
  ProjectPaths?: string[];
  SourceUrl?: string;
  /** Return the persisted last scan without contacting the feeds. */
  PreferCache?: boolean;
  /**
   * Optional correlation id. When supplied, the host records live progress for this
   * scan which the webview can poll with `getOutdatedScanProgressAsync`.
   */
  ScanId?: string;
};

export type GetInconsistentPackagesRequest = CacheControl & {
  ProjectPaths?: string[];
};

export type GetVulnerablePackagesRequest = CacheControl & {
  ProjectPaths?: string[];
};

export type UpdateProjectRequest = {
  ProjectPath: string;
  PackageId: string;
  Version?: string;
  Type: "INSTALL" | "UNINSTALL" | "UPDATE";
  SourceUrl?: string;
  OperationId?: string;
  CpmCondition?: string;
  CpmTfm?: string;
};

export type GetOperationProgressRequest = {
  OperationId: string;
};

export type GetOperationProgressResponse = {
  Stage: string;
  Percent: number;
  Active: boolean;
};

export type GetOutdatedScanProgressRequest = {
  ScanId: string;
};

export type GetOutdatedScanProgressResponse = {
  /** Human-readable stage, e.g. "Checking latest versions (12/60)…". */
  Stage: string;
  /** Overall completion, 0-100. */
  Percent: number;
  /** Units finished in the current stage (packages, projects, conditions). */
  Completed: number;
  /** Units in the current stage, or 0 when the stage has no countable units. */
  Total: number;
  /** False once the scan has finished or the id is unknown. */
  Active: boolean;
};

export type BatchUpdateRequest = {
  Updates: Array<{
    PackageId: string;
    Version: string;
    ProjectPaths: string[];
    CpmCondition?: string;  // raw XML Condition for framework-scoped CPM updates
    CpmTfm?: string;        // resolved TFM for display/telemetry
    Scope?: "group" | "unconditional" | "all" | "first";
  }>;
  SkipRestore?: boolean;
  /** Snapshot affected files, restore once, and roll back on failure. */
  Transactional?: boolean;
};

/**
 * One selected package whose requested version cannot be applied together with
 * the rest of the batch. Produced by the preflight check before anything is
 * written; `dotnet restore` remains the final authority.
 */
export type BatchUpdateConflict = {
  /** The selected package to drop from this batch. */
  PackageId: string;
  RequestedVersion: string;
  /** The package that declares the incompatible requirement. */
  BlockedByPackageId: string;
  /** The version of the blocking package (installed, or selected when it is in the batch). */
  BlockedByVersion: string;
  /** The NuGet range that rejects the effective version, e.g. `= 11.0.0-rc.2`. */
  RequiredRange: string;
  /** Lower bound of that range, when it has one. */
  RequiredVersion?: string;
  /** Target framework whose dependency group declared the requirement. */
  Tfm?: string;
  /** Step of the plan: 0 = apply first, higher = must wait for earlier steps. */
  Order?: number;
  /** Version the dependency graph would resolve for the blocked package. */
  EffectiveVersion: string;
  ProjectPath: string;
  Reason: string;
};

export type CheckBatchUpdateResponse = {
  Conflicts: BatchUpdateConflict[];
};

export type RestoreProjectsRequest = {
  ProjectPaths: string[];
};

export type UpdateBadgeRequest = {
  Count: number;
  /** Updates held back because installed dependencies pin an incompatible version. */
  BlockedCount?: number;
};

export type ConsolidateRequest = {
  PackageId: string;
  TargetVersion: string;
  ProjectPaths: string[];
  CpmCondition?: string;
  Scope?: "group" | "unconditional" | "all" | "first";
};

export type CleanupReport = {
  PropsFiles: Array<{ Path: string; Defined: string[]; Unused: string[] }>;
  Used: string[];
  Missing: string[];
  Unused: string[];
};

export type CleanupUnusedRequest = {
  ProjectPaths?: string[];
};

export type CleanupUnusedResponse = {
  Report: CleanupReport;
  Removed: string[];
  Backups: string[];
  Errors: string[];
};

export type UpdateConfigurationRequest = {
  Configuration: Configuration;
};

export type OpenUrlRequest = {
  Url: string;
};

export type UpdateStatusBarRequest = {
  Percentage: number | null;
  Message?: string;
};

export type ShowConfirmationRequest = {
  Message: string;
  Detail?: string;
};

export type ShowConfirmationResponse = {
  Confirmed: boolean;
};

// ============================================================
// Response Types (only data, errors handled by Result<T>)
// ============================================================

export type GetProjectsResponse = {
  Projects: Project[];
};

export type GetPackagesResponse = {
  Packages: Package[];
};

export type GetPackageResponse = {
  Package: Package;
  SourceUrl: string;
};

export type GetPackageDetailsResponse = {
  Package: PackageDetails;
};

export type GetPackageFrameworksResponse = {
  /** One entry per product; empty when the package version declares no framework assets. */
  Groups: PackageFrameworkGroup[];
};

export type GetOutdatedPackagesResponse = {
  Packages: OutdatedPackage[];
  /** Updates withheld because a dependency pins an incompatible version. */
  BlockedPackages?: Array<{
    Id: string;
    InstalledVersion: string;
    /** The version that was available but rejected by the dependency ranges. */
    BlockedVersion: string;
    Reason: string;
    BlockedBy: Array<{ PackageId: string; InstalledVersion: string; Range: string }>;
  }>;
  /** True when the payload came from the persisted scan cache. */
  FromCache?: boolean;
  /** ISO timestamp of the scan that produced the payload. */
  ScannedAt?: string;
};

export type GetInconsistentPackagesResponse = {
  Packages: InconsistentPackage[];
};

export type GetVulnerablePackagesResponse = {
  Packages: VulnerablePackage[];
};

export type UpdateProjectResponse = {
  Project: Project;
  IsCpmEnabled: boolean;
};

export type BatchUpdateResponse = {
  Results: Array<{
    PackageId: string;
    Success: boolean;
    Error?: string;
  }>;
  /** True when the host restored the pre-update file contents after a failure. */
  RolledBack?: boolean;
  /** The restore failure that triggered a rollback. */
  RestoreError?: string;
  /** A failure while restoring the snapshots or re-restoring the old versions. */
  RollbackError?: string;
  /**
   * Batch rows that the restore failure points at, so the user can retry
   * without them instead of re-selecting by hand.
   */
  ConflictingPackages?: string[];
  /** Structured cause of the failure, for the actionable error panel. */
  Failure?: DotnetFailureInfo;
  /** True when the user cancelled; the transaction was rolled back. */
  Cancelled?: boolean;
};

export type GetConfigurationResponse = {
  Configuration: Configuration;
};

// ============================================================
// Long-running operation jobs
// ============================================================

/**
 * Long mutations (batch update, single package update, consolidate, cleanup)
 * run as host-side jobs so no client deadline governs how long a
 * snapshot/write/restore sequence may take. The webview starts a job, polls
 * `getJobAsync` for stage + percent, and reads the final response once the job
 * is no longer `running`.
 */
export type JobKind = "batchUpdate" | "projectUpdate" | "consolidate" | "cleanup";

export type JobState = "running" | "completed" | "failed" | "cancelled";

export type JobStatus<TKind extends JobKind, TResponse> = {
  Kind: TKind;
  State: JobState;
  /** Human-readable stage, e.g. "Restoring updated projects…". */
  Stage: string;
  /** Overall completion, 0-100. */
  Percent: number;
  /** The operation outcome; present once State is not "running". */
  Response?: TResponse;
  /** A failure of the job itself (unexpected throw), not of a package. */
  Error?: string;
};

export type StartJobResponse = {
  JobId: string;
};

export type JobRequest = {
  JobId: string;
};

export type GetJobResponse =
  | JobStatus<"batchUpdate", BatchUpdateResponse>
  | JobStatus<"projectUpdate", UpdateProjectResponse>
  | JobStatus<"consolidate", void>
  | JobStatus<"cleanup", CleanupUnusedResponse>;

// ============================================================
// Wire Protocol (internal, over postMessage)
// ============================================================

export type RpcRequest = {
  type: "rpc-request";
  id: number;
  method: string;
  params: unknown;
};

export type RpcResponse = {
  type: "rpc-response";
  id: number;
  result: Result<unknown>;
};

export type RpcCancel = {
  type: "rpc-cancel";
  id: number;
};

export type RpcMessage = RpcRequest | RpcResponse | RpcCancel;

// ============================================================
// Toolchain diagnostics
// ============================================================

/**
 * Why a `dotnet` command failed, in a form the webview can render.
 * `Detail` is the trimmed raw output; never render it inline by default.
 */
export type DotnetFailureKind =
  | "WorkloadManifestConflict"
  | "SdkResolutionFailure"
  | "SdkPinMismatch"
  | "SdkSelectionMismatch"
  | "PinnedSdkMissing"
  | "RestoreConflict"
  | "VulnerabilityAudit"
  | "SourceUnavailable"
  | "PasswordScriptFailed"
  | "DotnetMissing"
  | "Unknown";

export interface DotnetFailureInfo {
  Kind: DotnetFailureKind;
  /** One line, user-facing, no stack. */
  Summary: string;
  /** What the user can do about it. */
  Hint: string;
  /** Relevant lines of the raw output. */
  Detail: string;
  /** Structured conflict chains, when the failure is a NuGet version conflict. */
  Conflicts?: RestoreConflictInfo[];
  SdkVersion?: string;
  GlobalJsonPath?: string;
  PinnedSdkVersion?: string;
  ProjectPath?: string;
}

/** A direct reference that the dependency graph already provides transitively. */
export type DependencyIssueKind = "Redundant" | "Pinned";

export type DependencyIssue = {
  ProjectPath: string;
  Tfm: string;
  PackageId: string;
  /** Version the project references directly. */
  DirectVersion: string;
  /** Version the restored graph resolves for this package. */
  ResolvedVersion: string;
  Kind: DependencyIssueKind;
  /** How the package arrives without the direct reference, e.g. "ParentA -> ParentB". */
  Chain: string;
};

export type GetDependencyIssuesRequest = {
  ProjectPaths?: string[];
  ForceRefresh?: boolean;
};

export type GetDependencyIssuesResponse = {
  Issues: DependencyIssue[];
  ProjectsScanned: number;
  /** Projects without a usable `project.assets.json` (not restored yet). */
  ProjectsSkipped: number;
  /** Those projects, so the caller can restore them and re-analyse. */
  SkippedProjectPaths: string[];
};

/** Serializable subset of a restore conflict, for the error card actions. */
export type RestoreConflictInfo = {
  Code: string;
  PackageId: string;
  SuggestedVersion?: string;
  Message: string;
  Chains: string[];
};

export type FixRestoreConflictRequest = {
  ProjectPath: string;
  PackageId: string;
  Version: string;
  /** `cpm` writes the props file group; `project` writes the PackageReference; omitted = auto-detect. */
  Target?: "cpm" | "project";
};

/** Raises central `PackageVersion` entries (CPM) to the versions a batch needs. */
export type UpdateCentralVersionsRequest = {
  ProjectPaths?: string[];
  Updates: Array<{
    PackageId: string;
    Version: string;
    /** Write into an `ItemGroup` with this MSBuild condition (per-TFM groups). */
    Condition?: string;
  }>;
};

export type UpdateCentralVersionsResponse = {
  Applied: string[];
  /** Packages with no matching `PackageVersion` entry (transitive-only, or misspelled). */
  Skipped: string[];
  PropsFile?: string;
  RestoreError?: string;
};

export type FixRestoreConflictResponse = {
  Applied: boolean;
  /** Restore output summary when the fix did not clear the conflict. */
  RestoreError?: string;
};

export type InstalledSdkInfo = {
  Version: string;
  Path: string;
  /** `system` = on PATH, `private` = installed by the extension under the user profile. */
  Source: "system" | "private";
};

export type ToolchainIssue = {
  Kind: DotnetFailureKind;
  Summary: string;
  Hint: string;
  Detail?: string;
};

/**
 * Health of the .NET toolchain as the extension will use it: the SDK selected
 * from the workspace directory, the pin from the nearest `global.json`, and
 * whether an actual project evaluation succeeds.
 */
export type ToolchainHealth = {
  DotnetFound: boolean;
  /** `dotnet --version` run with the workspace working directory. */
  SdkVersion?: string;
  /** `NETCoreSdkVersion` as resolved by MSBuild for a real project. */
  BuildSdkVersion?: string;
  /** `dotnet sdk check` status for the selected SDK, e.g. "Up to date." */
  SdkStatus?: string;
  /** True when `dotnet sdk check` could not run (offline, or no usable output). */
  SdkCheckUnavailable?: boolean;
  /** `sdk-manifests\<band>` folders no installed SDK owns (left-overs). */
  OrphanedManifestBands?: string[];
  /** The `dotnet` host that ran the check (PATH, or the extension's private install). */
  DotnetPath?: string;
  /** The project's own `global.json`, when one applies. */
  GlobalJsonPath?: string;
  PinnedSdkVersion?: string;
  SdkMatchesPin?: boolean;
  /** True when the smoke `dotnet msbuild -getProperty` evaluation failed. */
  ProjectEvaluationFailed: boolean;
  /** ISO timestamp of this check. */
  CheckedAt: string;
  InstalledSdks: InstalledSdkInfo[];
  Issues: ToolchainIssue[];
};

export type GetToolchainHealthRequest = {
  ForceRefresh?: boolean;
  /** Projects used for the smoke evaluation; the first valid one is enough. */
  ProjectPaths?: string[];
};

export type GetToolchainHealthResponse = {
  Health: ToolchainHealth;
};

export type RunToolchainDiagnosticsRequest = {
  ProjectPaths?: string[];
};

export type RunToolchainDiagnosticsResponse = {
  /** Redacted, clipboard-ready report. */
  Report: string;
};

/** Pins an installed SDK in the workspace's `global.json`. */
export type SetWorkspaceSdkRequest = {
  Version: string;
  /** Projects whose nearest `global.json` should be updated. */
  ProjectPaths?: string[];
};

export type SetWorkspaceSdkResponse = {
  GlobalJsonPath: string;
  Version: string;
  /** Other properties adjusted to keep the file consistent with the pin. */
  Notes: string[];
};

/** Maintenance commands that change installed workload manifests. */
export type WorkloadAction = "update" | "repair";

export type RunWorkloadCommandRequest = {
  Action: WorkloadAction;
  /** Projects that select the SDK band the command runs for. */
  ProjectPaths?: string[];
};

export type RunWorkloadCommandResponse = {
  Action: WorkloadAction;
  Succeeded: boolean;
  ExitCode: number | null;
  /** Verbatim command output (truncated to 20k characters). */
  Output: string;
  /** The command failed because it needs administrator rights. */
  NeedsElevation: boolean;
};

export type InstallSdkRequest = {
  Version: string;
};

export type InstallSdkResponse = {
  Installed: boolean;
  /** Where the SDK was installed (the extension's private host). */
  InstallRoot: string;
  DotnetPath?: string;
  SdkVersion: string;
};

// ============================================================
// Host API Contract
// ============================================================

export interface HostAPI {
  getProjectsAsync(req: CacheControl, signal?: AbortSignal): Promise<Result<GetProjectsResponse>>;
  getPackagesAsync(req: GetPackagesRequest, signal?: AbortSignal): Promise<Result<GetPackagesResponse>>;
  getPackageAsync(req: GetPackageRequest, signal?: AbortSignal): Promise<Result<GetPackageResponse>>;
  getPackageDetailsAsync(req: GetPackageDetailsRequest, signal?: AbortSignal): Promise<Result<GetPackageDetailsResponse>>;
  getPackageFrameworksAsync(req: GetPackageFrameworksRequest, signal?: AbortSignal): Promise<Result<GetPackageFrameworksResponse>>;
  updateProjectAsync(req: UpdateProjectRequest, signal?: AbortSignal): Promise<Result<UpdateProjectResponse>>;
  getConfigurationAsync(): Promise<Result<GetConfigurationResponse>>;
  updateConfigurationAsync(req: UpdateConfigurationRequest): Promise<Result<void>>;
  openUrlAsync(req: OpenUrlRequest): Promise<Result<void>>;
  updateStatusBarAsync(req: UpdateStatusBarRequest): Promise<Result<void>>;
  getOutdatedPackagesAsync(req: GetOutdatedPackagesRequest, signal?: AbortSignal): Promise<Result<GetOutdatedPackagesResponse>>;
  batchUpdatePackagesAsync(req: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<BatchUpdateResponse>>;
  checkBatchUpdateAsync(req: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<CheckBatchUpdateResponse>>;
  startBatchUpdateAsync(req: BatchUpdateRequest): Promise<Result<StartJobResponse>>;
  startProjectUpdateAsync(req: UpdateProjectRequest): Promise<Result<StartJobResponse>>;
  startConsolidateAsync(req: ConsolidateRequest): Promise<Result<StartJobResponse>>;
  startCleanupAsync(req: CleanupUnusedRequest): Promise<Result<StartJobResponse>>;
  getJobAsync(req: JobRequest): Promise<Result<GetJobResponse>>;
  cancelJobAsync(req: JobRequest): Promise<Result<void>>;
  restoreProjectsAsync(req: RestoreProjectsRequest, signal?: AbortSignal): Promise<Result<void>>;
  updateBadgeAsync(req: UpdateBadgeRequest): Promise<Result<void>>;
  getInconsistentPackagesAsync(req: GetInconsistentPackagesRequest, signal?: AbortSignal): Promise<Result<GetInconsistentPackagesResponse>>;
  consolidatePackagesAsync(req: ConsolidateRequest, signal?: AbortSignal): Promise<Result<void>>;
  getCleanupReportAsync(req: CleanupUnusedRequest, signal?: AbortSignal): Promise<Result<CleanupReport>>;
  cleanupUnusedPackagesAsync(req: CleanupUnusedRequest, signal?: AbortSignal): Promise<Result<CleanupUnusedResponse>>;
  getVulnerablePackagesAsync(req: GetVulnerablePackagesRequest, signal?: AbortSignal): Promise<Result<GetVulnerablePackagesResponse>>;
  showConfirmationAsync(req: ShowConfirmationRequest): Promise<Result<ShowConfirmationResponse>>;
  getOperationProgressAsync(req: GetOperationProgressRequest): Promise<Result<GetOperationProgressResponse>>;
  getOutdatedScanProgressAsync(req: GetOutdatedScanProgressRequest): Promise<Result<GetOutdatedScanProgressResponse>>;
  getToolchainHealthAsync(req: GetToolchainHealthRequest, signal?: AbortSignal): Promise<Result<GetToolchainHealthResponse>>;
  runToolchainDiagnosticsAsync(req: RunToolchainDiagnosticsRequest): Promise<Result<RunToolchainDiagnosticsResponse>>;
  setWorkspaceSdkAsync(req: SetWorkspaceSdkRequest): Promise<Result<SetWorkspaceSdkResponse>>;
  installSdkAsync(req: InstallSdkRequest): Promise<Result<InstallSdkResponse>>;
  runWorkloadCommandAsync(req: RunWorkloadCommandRequest): Promise<Result<RunWorkloadCommandResponse>>;
  getDependencyIssuesAsync(req: GetDependencyIssuesRequest, signal?: AbortSignal): Promise<Result<GetDependencyIssuesResponse>>;
  fixRestoreConflictAsync(req: FixRestoreConflictRequest): Promise<Result<FixRestoreConflictResponse>>;
  updateCentralVersionsAsync(req: UpdateCentralVersionsRequest): Promise<Result<UpdateCentralVersionsResponse>>;
}

// ============================================================
// RPC Timeout
// ============================================================

export const RPC_TIMEOUT_MS = 120_000;
