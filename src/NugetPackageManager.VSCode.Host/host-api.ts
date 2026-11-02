import * as vscode from "vscode";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  HostAPI,
  CacheControl,
  GetProjectsResponse,
  GetPackagesRequest,
  GetPackagesResponse,
  GetPackageRequest,
  GetPackageResponse,
  GetPackageDetailsRequest,
  GetPackageDetailsResponse,
  GetPackageFrameworksRequest,
  GetPackageFrameworksResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  GetConfigurationResponse,
  UpdateConfigurationRequest,
  OpenUrlRequest,
  UpdateStatusBarRequest,
  GetOutdatedPackagesRequest,
  GetOutdatedPackagesResponse,
  BatchUpdateRequest,
  BatchUpdateResponse,
  BatchUpdateConflict,
  CheckBatchUpdateResponse,
  JobRequest,
  GetJobResponse,
  StartJobResponse,
  RestoreProjectsRequest,
  UpdateBadgeRequest,
  GetInconsistentPackagesRequest,
  GetInconsistentPackagesResponse,
  ConsolidateRequest,
  CleanupReport,
  CleanupUnusedRequest,
  CleanupUnusedResponse,
  GetVulnerablePackagesRequest,
  GetVulnerablePackagesResponse,
  ShowConfirmationRequest,
  ShowConfirmationResponse,
  GetOperationProgressRequest,
  GetOperationProgressResponse,
  GetOutdatedScanProgressRequest,
  GetOutdatedScanProgressResponse,
  GetToolchainHealthRequest,
  GetToolchainHealthResponse,
  RunToolchainDiagnosticsRequest,
  RunToolchainDiagnosticsResponse,
  SetWorkspaceSdkRequest,
  SetWorkspaceSdkResponse,
  InstallSdkRequest,
  InstallSdkResponse,
  RunWorkloadCommandRequest,
  RunWorkloadCommandResponse,
  GetDependencyIssuesRequest,
  GetDependencyIssuesResponse,
  FixRestoreConflictRequest,
  FixRestoreConflictResponse,
  UpdateCentralVersionsRequest,
  UpdateCentralVersionsResponse,
  DependencyIssue,
  RestoreConflictInfo,
  ToolchainHealth,
} from "@/common/rpc/types";
import type { Result } from "@/common/rpc/result";
import { ok, fail } from "@/common/rpc/result";
import CpmReader, { type CpmFrameworkEntry, type CpmPackageMap } from "./utilities/cpm-reader";
import CpmWriter, { type CpmVersionChange } from "./utilities/cpm-writer";
import { findPathOutsideWorkspaceAsync } from "./utilities/workspace-path";
import { compareVersions, isVersionInRange, satisfiesVersionRange } from "./utilities/version";
import { isValidNuGetVersion, isValidPackageId } from "./utilities/nuget-identifier";
import nugetApiFactory, { ReadProxyUrl } from "./nuget/api-factory";
import coreProcess from "./nuget/core-process";
import { SetUpdateBadge } from "./view-badge";
import NuGetConfigResolver from "./utilities/nuget-config-resolver";
import TaskExecutor, { CreateDotnetOptions, DotnetError } from "./utilities/task-executor";
import { ClassifyDotnetFailureAsync, type DotnetFailure } from "./utilities/dotnet-failure";
import { BuildToolchainDiagnosticsAsync, ProbeToolchainAsync } from "./utilities/toolchain-health";
import { GetSdkInstallRoot } from "./utilities/sdk-locations";
import {
  IsValidSdkVersion as IsValidGlobalJsonSdkVersion,
  UpdateGlobalJsonSdkVersionAsync,
  WriteGlobalJsonSdkVersionAsync,
} from "./utilities/global-json";
import { InstallSdkAsync, IsValidSdkVersion, SdkInstallError } from "./utilities/sdk-install";
import { ResolveDotnetCommand, ResolveDotnetContext, ResolveWorkingDirectory } from "./utilities/dotnet-context";
import { RunWorkloadCommandAsync } from "./utilities/workload-commands";
import { ScopeProjectFiles } from "./utilities/project-scope";
import { ApplyConditionalPackageVersions } from "./utilities/cpm-conditional";
import StatusBarUtils from "./utilities/status-bar-utils";
import { Logger } from "@/common/logger";
import { getConfiguration, getSetting } from "@/common/configuration";
import { BuildScanCacheKey, ScanCacheStore } from "./scan-cache";
import { ScanProgress } from "./utilities/scan-progress";
import { OperationJobs, type JobReporter } from "./utilities/operation-jobs";
import { AxiosError } from "axios";

/**
 * Parses a .sln or .slnx file and returns the absolute paths of all project files it references.
 * Returns null if the file cannot be read or parsed.
 */
/** Flattens an SDK install failure into one line: message plus script output. */
interface CentralUpdatePlan {
  Applied: string[];
  Skipped: string[];
  Changes: CpmVersionChange[];
  Conditional: Array<{ PackageId: string; Version: string; Condition: string }>;
}

/** Splits the requested raises into unconditional, conditional and ignored ones. */
function PlanCentralUpdates(
  updates: UpdateCentralVersionsRequest["Updates"],
  defined: Set<string>
): CentralUpdatePlan {
  const plan: CentralUpdatePlan = { Applied: [], Skipped: [], Changes: [], Conditional: [] };
  for (const update of updates) {
    if (!isValidPackageId(update.PackageId) || !isValidNuGetVersion(update.Version)) {
      plan.Skipped.push(update.PackageId);
      continue;
    }
    if (update.Condition) {
      // Per-TFM requirement: written into its own conditional group, even when
      // no unconditional entry exists.
      plan.Conditional.push({
        PackageId: update.PackageId,
        Version: update.Version,
        Condition: update.Condition,
      });
      plan.Applied.push(update.PackageId);
      continue;
    }
    const definedId = [...defined].find((id) => id.toLowerCase() === update.PackageId.toLowerCase());
    if (!definedId) {
      // Transitive requirement without a PackageVersion entry: NuGet resolves
      // it on its own, nothing to raise.
      plan.Skipped.push(update.PackageId);
      continue;
    }
    plan.Changes.push({ packageId: definedId, version: update.Version, scope: "all" });
    plan.Applied.push(update.PackageId);
  }
  return plan;
}

async function WriteCentralVersionsAsync(
  propsFile: string,
  plan: CentralUpdatePlan,
  projectPaths: string[],
  workspaceRoots: string[]
): Promise<void> {
  if (plan.Changes.length > 0) {
    await CpmWriter.UpdateCpmVersionsAsync(propsFile, plan.Changes, projectPaths, workspaceRoots);
  }
  if (plan.Conditional.length === 0) return;

  const before = await fs.readFile(propsFile, "utf8");
  const written = ApplyConditionalPackageVersions(before, plan.Conditional, {
    // Two PackageVersion items for one package (unconditional + conditional)
    // make NuGet use the unconditional one, so it has to be replaced.
    ReplaceUnconditional: [...new Set(plan.Conditional.map((entry) => entry.PackageId))],
  });
  if (written.Changed) {
    await fs.writeFile(propsFile, written.Content, "utf8");
  }
  if (written.CreatedGroups.length > 0) {
    Logger.info(`updateCentralVersions: created conditional group(s) ${written.CreatedGroups.join(", ")}`);
  }
}

/** Flattens an SDK install failure into one line: message plus script output. */
function DescribeSdkInstallFailure(err: unknown): string {
  if (err instanceof SdkInstallError) {
    return [err.message, err.output].filter(Boolean).join(" ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function parseSolutionProjectPathsAsync(slnPath: string): Promise<string[] | null> {
  try {
    const content = await fs.readFile(slnPath, "utf-8");
    const slnDir = path.dirname(slnPath);
    const projectPaths: string[] = [];
    const ext = path.extname(slnPath).toLowerCase();

    if (ext === ".slnx") {
      // .slnx is XML: <Project Path="relative/path/to/Project.csproj" />
      const re = /<Project\s[^>]*\bPath="([^"]+\.(?:csproj|fsproj|vbproj))"/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const rel = m[1]!.replace(/\\/g, path.sep);
        projectPaths.push(path.resolve(slnDir, rel));
      }
    } else {
      // .sln text format: Project("...") = "Name", "relative\path.csproj", "{GUID}"
      const re = /^Project\([^)]+\)\s*=\s*"[^"]+",\s*"([^"]+\.(?:csproj|fsproj|vbproj))"/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        const rel = m[1]!.replace(/\\/g, path.sep);
        projectPaths.push(path.resolve(slnDir, rel));
      }
    }

    return projectPaths;
  } catch {
    return null;
  }
}

const DEFAULT_FRAMEWORK_ALIGNED_PATTERNS = [
  "Microsoft.Extensions.*",
  "Microsoft.AspNetCore.*",
  "Microsoft.EntityFrameworkCore.*",
  "Microsoft.Maui.*",
  "System.*",
];

function getCpmSettings(): {
  alignedPatterns: string[];
  extraTargetFrameworks: string[];
  excludeGlobs: string[];
} {
  return {
    alignedPatterns: getSetting<string[]>("frameworkAlignedPackages", DEFAULT_FRAMEWORK_ALIGNED_PATTERNS),
    extraTargetFrameworks: getSetting<string[]>("extraTargetFrameworks", []),
    excludeGlobs: getSetting<string[]>("excludeGlobs", []),
  };
}

function matchesPackagePattern(pattern: string, packageId: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(packageId);
}

function isFrameworkAlignedPackage(packageId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPackagePattern(pattern, packageId));
}

/**
 * Parses projects through the .NET core, which owns csproj reading, CPM resolution and
 * target-framework evaluation. Discovery stays here: which files belong to the workspace is a
 * VS Code question, and duplicating that globbing in the core would drift.
 */
async function parseProjectsAsync(projectPaths: string[], signal?: AbortSignal): Promise<Project[]> {
  if (projectPaths.length === 0) {
    return [];
  }

  return coreProcess.CallAsync<Project[]>(
    "getProjects",
    {
      projectPaths,
      extraTargetFrameworks: getCpmSettings().extraTargetFrameworks,
    },
    signal
  );
}

async function parseProjectAsync(projectPath: string, signal?: AbortSignal): Promise<Project> {
  const projects = await parseProjectsAsync([projectPath], signal);
  const project = projects[0];
  if (!project) {
    throw new Error(`The .NET core returned no project model for ${projectPath}`);
  }

  return project;
}

/** Keeps hidden/scratch directories out of every package and project scan. */
function isInternalExcludedPath(fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, "/").toLowerCase();
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath.replace(/\\/g, "/").toLowerCase().replace(/\/$/, ""))
    .filter(Boolean);
  const root = workspaceRoots.find(
    (candidate) => normalized === candidate || normalized.startsWith(`${candidate}/`)
  );
  const relative = root ? normalized.slice(root.length).replace(/^\/+/, "") : normalized;
  const segments = relative.split("/");
  // The final segment is the file; any hidden directory above it is excluded.
  return segments.slice(0, -1).some((segment) => segment.startsWith("."));
}

/** Excludes configured globs (for example bin and obj folders) from project discovery. */
function applyExcludeGlobs<T extends { fsPath: string }>(files: T[], excludeGlobs: string[]): T[] {
  const visibleFiles = files.filter((file) => !isInternalExcludedPath(file.fsPath));
  if (excludeGlobs.length === 0) return visibleFiles;
  const patterns = excludeGlobs.map(
    (glob) =>
      new RegExp(
        `^${glob
          .replace(/\\/g, "/")
          .replace(/[.+?^${}()|[\]\\]/g, String.raw`\$&`)
          .replace(/\*\*/g, "\0")
          .replace(/\*/g, "[^/]*")
          .replace(/\0/g, ".*")
          .replace(/\/$/, "")}$`,
        "i"
      )
  );
  return visibleFiles.filter((file) => {
    const normalized = file.fsPath.replace(/\\/g, "/");
    return !patterns.some((pattern) => pattern.test(normalized));
  });
}

function sortPackages(packages: Package[], sort?: string): Package[] {
  if (!sort || sort === "relevance" || sort === "recent") return packages;
  const copy = [...packages];
  if (sort === "downloads") {
    return copy.sort((a, b) => (b.TotalDownloads ?? 0) - (a.TotalDownloads ?? 0));
  }
  if (sort === "name-asc") {
    return copy.sort((a, b) => a.Id.localeCompare(b.Id));
  }
  return packages;
}

function getWorkspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/** Returns the first path outside the workspace, or null when every path is safe. */
async function findOutsideWorkspaceAsync(paths: string[]): Promise<string | null> {
  return findPathOutsideWorkspaceAsync(paths, getWorkspaceRoots());
}

function extractResponseDetail(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (typeof data === "object") {
    const obj = data as Record<string, unknown>;
    // GitLab: { error: "invalid_token", error_description: "Token is expired..." }
    if (typeof obj.error_description === "string") return obj.error_description;
    if (typeof obj.error === "string") return obj.error;
    if (typeof obj.message === "string") return obj.message;
  }
  return "";
}

function formatApiError(err: unknown): string {
  if (err instanceof AxiosError) return formatAxiosError(err);
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function formatAxiosError(err: AxiosError): string {
  const status = err.response?.status;
  const url = err.config?.url ?? "unknown URL";
  const detail = extractResponseDetail(err.response?.data);
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401) {
    return `Authentication failed (401) for ${url}.${suffix || " Check your credentials or access token."}`;
  }
  if (status === 403) {
    return `Access denied (403) for ${url}.${suffix || " Your token may lack the required permissions."}`;
  }
  if (status === 404) {
    return `Source not found (404): ${url}${suffix}`;
  }
  if (status) {
    return `HTTP ${status} from ${url}: ${err.message}${suffix}`;
  }
  if (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND") {
    return `Cannot connect to ${url} (${err.code}). Check your network or source URL.`;
  }
  return `Network error for ${url}: ${err.message}`;
}

/**
 * Shared implementation of the direct `batchUpdatePackagesAsync` RPC and the
 * background batch update job. `report` streams stage/percent to the job
 * registry so the webview can render progress without holding a request open.
 */
async function runBatchUpdateAsync(
  request: BatchUpdateRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<BatchUpdateResponse>> {
  Logger.info(`batchUpdatePackages: Updating ${request.Updates.length} packages`);
  report("Preparing update…", 2);

  const outsideWorkspace = await findOutsideWorkspaceAsync(
    request.Updates.flatMap((update) => update.ProjectPaths)
  );
  if (outsideWorkspace) {
    return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
  }

  const transactional = request.Transactional === true;
  const skipRestore = request.SkipRestore === true || getSetting<boolean>("skipRestore", false);
  const allProjectPaths = [...new Set(request.Updates.flatMap((update) => update.ProjectPaths))];

  // Build the CPM map cache and context before snapshotting: the snapshot set now depends on the
  // same plan the write uses, so a property file returned by `resolveCpmWriteTargets` can be
  // captured before the first edit.
  const context: BatchUpdateContext = {
    cpmMapCache: new Map<string, Promise<CpmPackageMap>>(),
    skipRestore,
    transactional,
    signal,
    workspaceRoots: getWorkspaceRoots(),
  };

  report("Snapshotting files…", 3);
  const snapshots = transactional
    ? await snapshotFilesAsync(await collectBatchFilesAsync(request.Updates, allProjectPaths, context))
    : undefined;

  report("Updating packages…", 5);
  const results: BatchUpdateRow[] = [];

  let transactionFailed = false;
  for (const [i, update] of request.Updates.entries()) {
    if (signal?.aborted) break;
    report(
      `Updating ${update.PackageId} (${i + 1}/${request.Updates.length})…`,
      5 + (i / Math.max(1, request.Updates.length)) * 70
    );
    StatusBarUtils.ShowText(
      `Updating ${update.PackageId} to ${update.Version} (${i + 1}/${request.Updates.length})...`
    );

    const row = await applyBatchUpdateAsync(update, context);
    results.push(row);
    if (!row.Success && transactional) {
      transactionFailed = true;
      break;
    }
  }

  if (signal?.aborted) {
    // An explicit cancel rolls back whatever the transaction already wrote; it
    // never leaves a partially applied update behind.
    transactionFailed = transactional;
  }

  if (transactional) {
    return finalizeTransactionalBatchAsync({
      request,
      allProjectPaths,
      snapshots,
      results,
      transactionFailed,
      skipRestore,
      signal,
      report,
    });
  }

  StatusBarUtils.hide();
  report("Completed", 100);
  const response: BatchUpdateResponse = { Results: results };
  if (signal?.aborted) response.Cancelled = true;
  return ok(response);
}

type BatchUpdateRow = { PackageId: string; Success: boolean; Error?: string };

type BatchUpdateContext = {
  cpmMapCache: Map<string, Promise<CpmPackageMap>>;
  skipRestore: boolean;
  transactional: boolean;
  signal: AbortSignal | undefined;
  workspaceRoots: string[];
};

async function collectBatchFilesAsync(
  updates: BatchUpdateRequest["Updates"],
  allProjectPaths: string[],
  context: BatchUpdateContext
): Promise<string[]> {
  const affectedFiles = new Set<string>(allProjectPaths);
  for (const update of updates) {
    for (const projectPath of update.ProjectPaths) {
      const cpmFilePath = await CpmReader.FindCpmFilePathAsync(projectPath);
      if (cpmFilePath) affectedFiles.add(cpmFilePath);
    }

    // A property-based version is written into the file that declares the property
    // (e.g. Directory.Build.props), not the props file, so those targets must be snapshotted too.
    for (const target of await resolveBatchWriteTargetsAsync(update, context)) {
      affectedFiles.add(target);
    }
  }
  return [...affectedFiles];
}

/**
 * The files the CPM write for one batch update would edit, resolved read-only before snapshotting.
 * Planning is best-effort: a failure for one update must not abort the batch, so the write path
 * reports the real error per update.
 */
async function resolveBatchWriteTargetsAsync(
  update: BatchUpdateRequest["Updates"][number],
  context: BatchUpdateContext
): Promise<string[]> {
  if (!isValidPackageId(update.PackageId)) return [];
  if (update.Version && !isValidNuGetVersion(update.Version)) return [];

  try {
    const { changesByFile, projectsByFile } = await resolveCpmChangesForUpdateAsync(
      update,
      context.cpmMapCache
    );
    const targets: string[] = [];
    for (const [propsFilePath, changes] of changesByFile) {
      const resolved = await CpmWriter.ResolveWriteTargetsAsync(
        propsFilePath,
        changes,
        projectsByFile.get(propsFilePath) ?? [],
        context.workspaceRoots
      );
      targets.push(...resolved);
    }
    return targets;
  } catch {
    // The snapshot stays as-is; the write path surfaces the error.
    return [];
  }
}

async function applyBatchUpdateAsync(
  update: BatchUpdateRequest["Updates"][number],
  context: BatchUpdateContext
): Promise<BatchUpdateRow> {
  if (!isValidPackageId(update.PackageId)) {
    return { PackageId: update.PackageId, Success: false, Error: `Invalid NuGet package ID: ${update.PackageId}` };
  }
  if (update.Version && !isValidNuGetVersion(update.Version)) {
    return { PackageId: update.PackageId, Success: false, Error: `Invalid NuGet version: ${update.Version}` };
  }

  try {
    const { changesByFile, nonCpmProjects, projectsByFile } = await resolveCpmChangesForUpdateAsync(
      update,
      context.cpmMapCache
    );
    for (const [propsFilePath, changes] of changesByFile) {
      await CpmWriter.UpdateCpmVersionsAsync(
        propsFilePath,
        changes,
        projectsByFile.get(propsFilePath) ?? [],
        context.workspaceRoots
      );
    }
    for (const projectPath of nonCpmProjects) {
      // A transactional batch restores once at the end; letting `dotnet add`
      // restore here would turn one restore into one per package.
      await executeAddPackageAsync(
        update.PackageId,
        projectPath,
        update.Version,
        context.skipRestore || (context.transactional && !context.skipRestore),
        undefined,
        undefined,
        context.signal
      );
    }
    Logger.info(`batchUpdatePackages: Updated ${update.PackageId} to ${update.Version}`);
    return { PackageId: update.PackageId, Success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(`batchUpdatePackages: Failed to update ${update.PackageId}`, err);
    return { PackageId: update.PackageId, Success: false, Error: message };
  }
}

async function resolveCpmChangesForUpdateAsync(
  update: BatchUpdateRequest["Updates"][number],
  cpmMapCache: Map<string, Promise<CpmPackageMap>>
): Promise<{
  changesByFile: Map<string, CpmVersionChange[]>;
  nonCpmProjects: string[];
  projectsByFile: Map<string, string[]>;
}> {
  const changesByFile = new Map<string, CpmVersionChange[]>();
  const nonCpmProjects: string[] = [];
  const projectsByFile = new Map<string, string[]>();

  for (const projectPath of update.ProjectPaths) {
    const cpmFilePath = await CpmReader.FindCpmFilePathAsync(projectPath);
    const cpmMap = cpmFilePath ? await loadBatchCpmMapAsync(cpmFilePath, cpmMapCache) : null;

    if (!cpmMap || !CpmReader.HasPackage(cpmMap, update.PackageId)) {
      nonCpmProjects.push(projectPath);
      continue;
    }
    if (!update.Version) {
      throw new Error(`Version is required for CPM package update: ${update.PackageId}`);
    }

    const { condition, scope } = resolveCpmScope(update, cpmMap);
    const change: CpmVersionChange = {
      packageId: update.PackageId,
      version: update.Version,
      scope,
    };
    if (condition !== undefined) change.condition = condition;
    addCpmChange(changesByFile, cpmFilePath!, change);

    // Track every project governed by this props file so the property locator can confirm they
    // agree on where the property is defined.
    const projects = projectsByFile.get(cpmFilePath!) ?? [];
    if (!projects.includes(projectPath)) projects.push(projectPath);
    projectsByFile.set(cpmFilePath!, projects);
  }

  return { changesByFile, nonCpmProjects, projectsByFile };
}

async function loadBatchCpmMapAsync(
  cpmFilePath: string,
  cpmMapCache: Map<string, Promise<CpmPackageMap>>
): Promise<CpmPackageMap> {
  if (!cpmMapCache.has(cpmFilePath)) {
    cpmMapCache.set(cpmFilePath, CpmReader.ParseCpmFileAsync(cpmFilePath));
  }
  return cpmMapCache.get(cpmFilePath)!;
}

function resolveCpmScope(
  update: BatchUpdateRequest["Updates"][number],
  cpmMap: CpmPackageMap
): { condition: string | undefined; scope: NonNullable<CpmVersionChange["scope"]> } {
  if (update.CpmCondition !== undefined) {
    return { condition: update.CpmCondition, scope: update.Scope ?? "group" };
  }

  const unconditional = cpmMap.unconditional.has(update.PackageId)
    || [...cpmMap.unconditional.keys()].some(
      (id) => id.toLowerCase() === update.PackageId.toLowerCase()
    );
  const conditionalGroups = cpmMap.conditional.filter((entry) =>
    [...entry.versions.keys()].some(
      (id) => id.toLowerCase() === update.PackageId.toLowerCase()
    )
  );

  if (!unconditional && conditionalGroups.length === 1 && conditionalGroups[0]) {
    return { condition: conditionalGroups[0].condition, scope: update.Scope ?? "group" };
  }
  if (unconditional) {
    return { condition: undefined, scope: update.Scope ?? "unconditional" };
  }
  throw new Error(
    `Package ${update.PackageId} has multiple framework-scoped versions; specify CpmCondition.`
  );
}

function addCpmChange(
  changesByFile: Map<string, CpmVersionChange[]>,
  propsFilePath: string,
  change: CpmVersionChange
): void {
  const list = changesByFile.get(propsFilePath) ?? [];
  const existing = list.find(
    (item) => item.packageId === change.packageId && item.condition === change.condition
  );
  if (existing && existing.version !== change.version) {
    throw new Error(
      `Conflicting versions requested for ${change.packageId} in ${propsFilePath}: ${existing.version} vs ${change.version}`
    );
  }
  list.push(change);
  changesByFile.set(propsFilePath, list);
}

async function finalizeTransactionalBatchAsync(params: {
  request: BatchUpdateRequest;
  allProjectPaths: string[];
  snapshots: Map<string, FileSnapshot> | undefined;
  results: BatchUpdateRow[];
  transactionFailed: boolean;
  skipRestore: boolean;
  signal: AbortSignal | undefined;
  report: JobReporter;
}): Promise<Result<BatchUpdateResponse>> {
  const { request, allProjectPaths, snapshots, results, transactionFailed, skipRestore, signal, report } = params;
  let restoreFailure: RestoreFailure | null = null;

  if (!transactionFailed && !skipRestore) {
    report("Restoring updated projects…", 80);
    StatusBarUtils.ShowText("Restoring updated projects...");
    restoreFailure = await restoreProjectsInternalAsync(
      allProjectPaths,
      signal,
      true,
      ({ projectPath, index, total, stage, percent }) => {
        // One long static bar makes a slow solution look hung; dotnet's own
        // stage keeps it moving and names the project being restored.
        const projectName = path.basename(projectPath);
        report(
          `${stage} — ${projectName} (${index + 1}/${total})`,
          80 + (15 * (index + percent / 100)) / Math.max(1, total)
        );
      }
    );
  }

  const failedRestore = restoreFailure?.message;
  if (!transactionFailed && !failedRestore) {
    StatusBarUtils.hide();
    report("Completed", 100);
    const response: BatchUpdateResponse = { Results: results };
    if (signal?.aborted) response.Cancelled = true;
    return ok(response);
  }

  report("Rolling back…", 90);
  const conflictingPackages = attributeRestoreConflicts(restoreFailure, request.Updates);
  const rollbackError = await rollbackFilesAsync(snapshots);
  let rollbackRestoreError: string | undefined;
  if (!skipRestore) {
    rollbackRestoreError = (await restoreProjectsInternalAsync(allProjectPaths, signal, false))?.message;
  }
  StatusBarUtils.hide();
  Logger.error("batchUpdatePackages: Transaction rolled back", failedRestore ?? "write failure");

  const response: BatchUpdateResponse = { Results: results, RolledBack: true };
  if (failedRestore) response.RestoreError = failedRestore;
  if (restoreFailure?.failure) response.Failure = restoreFailure.failure;
  const rollbackMessage = rollbackError ?? rollbackRestoreError;
  if (rollbackMessage) response.RollbackError = rollbackMessage;
  if (conflictingPackages.length > 0) response.ConflictingPackages = conflictingPackages;
  if (signal?.aborted) response.Cancelled = true;
  return ok(response);
}

/**
 * Shared implementation of `updateProjectAsync` and the project update job.
 * `report` streams stage/percent to the job registry.
 */
async function runProjectUpdateAsync(
  request: UpdateProjectRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<UpdateProjectResponse>> {
  Logger.info(`updateProject: ${request.Type} ${request.PackageId} in ${request.ProjectPath}`);
  report("Preparing update…", 5);

  const validationError = await validateProjectUpdateAsync(request);
  if (validationError) return fail(validationError);
  if (signal?.aborted) return fail("cancelled");

  const cpm = await loadProjectCpmStateAsync(request);
  const cpmScope = resolveProjectCpmScope(request, cpm);
  if ("error" in cpmScope) return fail(cpmScope.error);

  const skipRestore = !!getSetting<boolean>("skipRestore", false) && !cpm.isCpmEnabled;

  // A single-package operation mutates at least the project file and, for CPM,
  // Directory.Packages.props. Uninstall can also prune other props files, so
  // snapshot all of them up front. A failed restore then leaves the workspace
  // exactly as it was, matching the batch path.
  report("Snapshotting files…", 10);
  const snapshots = await snapshotProjectUpdateAsync(request, cpm, cpmScope);

  try {
    report("Writing package reference…", 30);
    await applyProjectUpdateAsync(request, cpm, cpmScope, skipRestore, signal, report);
  } catch (err) {
    return fail(await buildProjectUpdateFailureAsync(err, request, snapshots, skipRestore, signal, report));
  } finally {
    StatusBarUtils.hide();
  }

  nugetApiFactory.ClearCache();
  report("Refreshing project…", 95);
  const project = await parseProjectAsync(request.ProjectPath, signal);

  return ok({ Project: project, IsCpmEnabled: cpm.isCpmEnabled });
}

type ProjectCpmState = {
  cpmMap: CpmPackageMap | null;
  isCpmEnabled: boolean;
  isCpmPackage: boolean;
};

type ProjectCpmScope =
  | { error: string }
  | { condition: string | undefined; scope: "group" | "unconditional" };

async function validateProjectUpdateAsync(request: UpdateProjectRequest): Promise<string | null> {
  const outsideWorkspace = await findOutsideWorkspaceAsync([request.ProjectPath]);
  if (outsideWorkspace) return `Project path is outside the workspace: ${outsideWorkspace}`;
  if (!isValidPackageId(request.PackageId)) return `Invalid NuGet package ID: ${request.PackageId}`;
  if (request.Version && !isValidNuGetVersion(request.Version)) {
    return `Invalid NuGet version: ${request.Version}`;
  }
  if (request.SourceUrl && !isHttpUrl(request.SourceUrl)) {
    return `Invalid source URL: ${request.SourceUrl}`;
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

async function loadProjectCpmStateAsync(request: UpdateProjectRequest): Promise<ProjectCpmState> {
  const cpmMap = await CpmReader.GetFrameworkPackageMapAsync(request.ProjectPath);
  const isCpmEnabled = cpmMap !== null;
  return {
    cpmMap,
    isCpmEnabled,
    isCpmPackage: isCpmEnabled && CpmReader.HasPackage(cpmMap, request.PackageId),
  };
}

function resolveProjectCpmScope(request: UpdateProjectRequest, cpm: ProjectCpmState): ProjectCpmScope {
  if (request.Type === "UNINSTALL" || !cpm.isCpmPackage || !cpm.cpmMap) {
    return { condition: undefined, scope: "group" };
  }
  if (!request.Version?.trim()) {
    return { error: "An explicit version is required when updating a Centrally Managed (CPM) package." };
  }

  const conditionalGroups = cpm.cpmMap.conditional.filter((entry) =>
    [...entry.versions.keys()].some(
      (id) => id.toLowerCase() === request.PackageId.toLowerCase()
    )
  );
  const unconditional = [...cpm.cpmMap.unconditional.keys()].some(
    (id) => id.toLowerCase() === request.PackageId.toLowerCase()
  );
  const onlyGroup = !unconditional && conditionalGroups.length === 1
    ? conditionalGroups[0]
    : undefined;

  if (request.CpmCondition !== undefined) {
    return { condition: request.CpmCondition, scope: "group" };
  }
  if (unconditional) return { condition: undefined, scope: "unconditional" };
  if (onlyGroup) return { condition: onlyGroup.condition, scope: "group" };
  return {
    error: `Package ${request.PackageId} has multiple framework-scoped versions; update it from the Updates tab.`,
  };
}

async function snapshotProjectUpdateAsync(
  request: UpdateProjectRequest,
  cpm: ProjectCpmState,
  cpmScope: ProjectCpmScope
): Promise<Map<string, FileSnapshot>> {
  const snapshotPaths = new Set<string>([request.ProjectPath]);
  const cpmFilePath = await CpmReader.FindCpmFilePathAsync(request.ProjectPath);
  if (cpmFilePath) snapshotPaths.add(cpmFilePath);
  if (request.Type === "UNINSTALL" && cpm.isCpmEnabled) {
    const propsFiles = await vscode.workspace.findFiles(
      "**/Directory.Packages.props",
      "**/{bin,obj,node_modules,.git}/**"
    );
    for (const file of propsFiles) snapshotPaths.add(file.fsPath);
  }

  // Preflight a CPM UPDATE so the file that declares a property-based version is snapshotted too.
  for (const target of await resolveProjectUpdateTargetsAsync(request, cpm, cpmScope, cpmFilePath)) {
    snapshotPaths.add(target);
  }

  return snapshotFilesAsync([...snapshotPaths]);
}

/**
 * The property file a single CPM UPDATE would edit, resolved read-only before the write.
 * Best-effort: a planning failure only narrows the snapshot; the write reports the real error.
 */
async function resolveProjectUpdateTargetsAsync(
  request: UpdateProjectRequest,
  cpm: ProjectCpmState,
  cpmScope: ProjectCpmScope,
  cpmFilePath: string | null
): Promise<string[]> {
  if (
    request.Type === "UNINSTALL" ||
    !cpm.isCpmEnabled ||
    !cpm.isCpmPackage ||
    !cpmFilePath ||
    !request.Version
  ) {
    return [];
  }

  try {
    const scope = "scope" in cpmScope ? cpmScope.scope : "group";
    const condition = "condition" in cpmScope ? cpmScope.condition : undefined;
    const change: CpmVersionChange = { packageId: request.PackageId, version: request.Version, scope };
    if (condition !== undefined) change.condition = condition;

    return await CpmWriter.ResolveWriteTargetsAsync(
      cpmFilePath,
      [change],
      [request.ProjectPath],
      getWorkspaceRoots()
    );
  } catch {
    return [];
  }
}

async function applyProjectUpdateAsync(
  request: UpdateProjectRequest,
  cpm: ProjectCpmState,
  cpmScope: ProjectCpmScope,
  skipRestore: boolean,
  signal: AbortSignal | undefined,
  report: JobReporter
): Promise<void> {
  if (request.Type === "UNINSTALL") {
    await executeRemovePackageAsync(request.PackageId, request.ProjectPath, request.OperationId, signal);
    if (cpm.isCpmPackage) {
      await cleanupUnusedCpmPackageAsync(request.PackageId, signal);
    }
    return;
  }

  if (cpm.isCpmEnabled && cpm.isCpmPackage) {
    const scope = "scope" in cpmScope ? cpmScope.scope : "group";
    const condition = "condition" in cpmScope ? cpmScope.condition : undefined;
    await CpmWriter.UpdatePackageVersionAsync(
      request.ProjectPath,
      request.PackageId,
      request.Version!,
      condition,
      scope,
      getWorkspaceRoots()
    );
    if (!skipRestore) {
      report("Restoring project…", 60);
      await TaskExecutor.ExecuteCommandAsync(
        "dotnet",
        ["restore", request.ProjectPath.replace(/\\/g, "/")],
        request.OperationId ?? `restore-${request.PackageId}`,
        signal,
        undefined,
        undefined,
        CreateDotnetOptions(request.ProjectPath)
      );
    }
    return;
  }

  await executeAddPackageAsync(
    request.PackageId,
    request.ProjectPath,
    request.Version,
    skipRestore,
    request.SourceUrl,
    request.OperationId,
    signal,
  );
}

async function buildProjectUpdateFailureAsync(
  err: unknown,
  request: UpdateProjectRequest,
  snapshots: Map<string, FileSnapshot>,
  skipRestore: boolean,
  signal: AbortSignal | undefined,
  report: JobReporter
): Promise<string> {
  const message = err instanceof Error ? err.message : String(err);
  const classified = err instanceof DotnetError
    ? err.failure ?? await ClassifyDotnetFailureAsync(err.output, { ProjectPath: request.ProjectPath })
    : undefined;
  const detail = classified ? `${classified.Summary} ${classified.Hint}` : null;

  report("Rolling back…", 90);
  let rollbackError = await rollbackFilesAsync(snapshots);
  if (!skipRestore && !signal?.aborted) {
    // Best effort: bring the restored graph back in line with the rolled-back
    // files. A failure here is reported with the original error rather than
    // masking it.
    const restoreFailure = await restoreProjectsInternalAsync([request.ProjectPath], signal, false);
    if (restoreFailure) {
      rollbackError = [rollbackError, restoreFailure.message].filter(Boolean).join("; ");
    }
  }
  Logger.error(`updateProject: Rolled back ${request.Type.toLowerCase()} of ${request.PackageId}`, err);

  let action = "update";
  if (request.Type === "UNINSTALL") action = "uninstall";
  else if (request.Type === "INSTALL") action = "install";

  const rollbackNote = rollbackError ? ` (rollback incomplete: ${rollbackError})` : " (rolled back)";
  return `Failed to ${action} package: ${detail ?? message}${rollbackNote}`;
}

/**
 * Shared implementation of `cleanupUnusedPackagesAsync` and the cleanup job.
 * `report` streams stage/percent to the job registry.
 */
async function runCleanupAsync(
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<CleanupUnusedResponse>> {
  try {
    report("Scanning projects for unused packages…", 5);
    const cleanupReport = await buildCleanupReportAsync(signal);
    const removed: string[] = [];
    const backups: string[] = [];
    const errors: string[] = [];
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    for (const [i, propsFile] of cleanupReport.PropsFiles.entries()) {
      if (propsFile.Unused.length === 0) continue;
      report(
        `Cleaning ${propsFile.Path} (${i + 1}/${cleanupReport.PropsFiles.length})…`,
        10 + (i / Math.max(1, cleanupReport.PropsFiles.length)) * 80
      );
      await cleanupPropsFileAsync(propsFile, stamp, { removed, backups, errors }, signal);
    }

    return ok({ Report: cleanupReport, Removed: [...new Set(removed)], Backups: backups, Errors: errors });
  } catch (err) {
    return fail(`Failed to clean unused packages: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type CleanupAccumulator = { removed: string[]; backups: string[]; errors: string[] };

async function cleanupPropsFileAsync(
  propsFile: CleanupReport["PropsFiles"][number],
  stamp: string,
  acc: CleanupAccumulator,
  signal: AbortSignal | undefined
): Promise<void> {
  const backupPath = `${propsFile.Path}.backup.${stamp}`;
  try {
    await fs.copyFile(propsFile.Path, backupPath);
    acc.backups.push(backupPath);
  } catch (err) {
    acc.errors.push(`Backup failed for ${propsFile.Path}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await removeUnusedFromPropsAsync(propsFile, acc, signal);
}

async function removeUnusedFromPropsAsync(
  propsFile: CleanupReport["PropsFiles"][number],
  acc: CleanupAccumulator,
  signal: AbortSignal | undefined
): Promise<void> {
  for (const packageId of propsFile.Unused) {
    if (signal?.aborted) break;
    try {
      const didRemove = await CpmWriter.RemovePackageVersionAsync(propsFile.Path, packageId);
      if (didRemove) acc.removed.push(packageId);
    } catch (err) {
      acc.errors.push(`Failed to remove ${packageId} from ${propsFile.Path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
/**
 * Shared implementation of `consolidatePackagesAsync` and the consolidation
 * job. `report` streams stage/percent to the job registry.
 */
async function runConsolidateAsync(
  request: ConsolidateRequest,
  signal?: AbortSignal,
  report: JobReporter = () => {}
): Promise<Result<void>> {
  Logger.info(
    `consolidatePackages: ${request.PackageId} to ${request.TargetVersion} across ${request.ProjectPaths.length} projects`
  );
  report("Preparing consolidation…", 5);

  const validationError = await validateConsolidateAsync(request);
  if (validationError) return fail(validationError);

  try {
    const { changesByFile, nonCpmProjects } = await collectConsolidationChangesAsync(request, signal, report);

    report("Writing package versions…", 60);
    for (const [propsFilePath, changes] of changesByFile) {
      await CpmWriter.UpdateCpmVersionsAsync(
        propsFilePath,
        changes,
        request.ProjectPaths,
        getWorkspaceRoots()
      );
    }

    await applyConsolidationAddsAsync(request, nonCpmProjects, signal);
    await restoreConsolidatedProjectsAsync(request, report);

    StatusBarUtils.hide();
    report("Completed", 100);
    Logger.info(`consolidatePackages: Done`);
    return ok(undefined as void);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    Logger.error(`consolidatePackages: Failed`, err);
    StatusBarUtils.hide();
    return fail(`Failed to consolidate: ${message}`);
  }
}

async function validateConsolidateAsync(request: ConsolidateRequest): Promise<string | null> {
  const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
  if (outsideWorkspace) return `Project path is outside the workspace: ${outsideWorkspace}`;
  if (!isValidPackageId(request.PackageId)) return `Invalid NuGet package ID: ${request.PackageId}`;
  if (!isValidNuGetVersion(request.TargetVersion)) return `Invalid NuGet version: ${request.TargetVersion}`;
  return null;
}

async function collectConsolidationChangesAsync(
  request: ConsolidateRequest,
  signal: AbortSignal | undefined,
  report: JobReporter
): Promise<{ changesByFile: Map<string, CpmVersionChange[]>; nonCpmProjects: string[] }> {
  const changesByFile = new Map<string, CpmVersionChange[]>();
  const nonCpmProjects: string[] = [];
  const cpmMapCache = new Map<string, Promise<CpmPackageMap>>();

  for (const [i, projectPath] of request.ProjectPaths.entries()) {
    if (signal?.aborted) break;
    report(
      `Consolidating ${request.PackageId} (${i + 1}/${request.ProjectPaths.length})…`,
      10 + (i / Math.max(1, request.ProjectPaths.length)) * 40
    );
    StatusBarUtils.ShowText(
      `Consolidating ${request.PackageId} (${i + 1}/${request.ProjectPaths.length})...`
    );

    const cpmFilePath = await CpmReader.FindCpmFilePathAsync(projectPath);
    const cpmMap = cpmFilePath ? await loadBatchCpmMapAsync(cpmFilePath, cpmMapCache) : null;
    if (!cpmMap || !CpmReader.HasPackage(cpmMap, request.PackageId)) {
      nonCpmProjects.push(projectPath);
      continue;
    }

    addCpmChange(changesByFile, cpmFilePath!, resolveConsolidationChange(request, cpmMap));
  }

  return { changesByFile, nonCpmProjects };
}

function resolveConsolidationChange(request: ConsolidateRequest, cpmMap: CpmPackageMap): CpmVersionChange {
  const conditionalGroups = cpmMap.conditional.filter((entry) =>
    [...entry.versions.keys()].some(
      (id) => id.toLowerCase() === request.PackageId.toLowerCase()
    )
  );

  // Consolidation is per framework line. A blanket scope would rewrite every
  // framework version of the package to one target, which is exactly what
  // multi-framework CPM files must avoid.
  if (
    (request.Scope === "all" || request.Scope === "first")
    && conditionalGroups.length > 0
  ) {
    throw new Error(
      `Package ${request.PackageId} has framework-scoped versions; consolidate one framework line at a time.`
    );
  }

  const { condition, scope } = resolveConsolidationScope(request, cpmMap, conditionalGroups);
  const change: CpmVersionChange = {
    packageId: request.PackageId,
    version: request.TargetVersion,
    scope,
  };
  if (condition !== undefined) change.condition = condition;
  return change;
}

function resolveConsolidationScope(
  request: ConsolidateRequest,
  cpmMap: CpmPackageMap,
  conditionalGroups: CpmFrameworkEntry[]
): { condition: string | undefined; scope: NonNullable<CpmVersionChange["scope"]> } {
  let condition = request.CpmCondition;
  let scope = request.Scope;

  if (condition === undefined && scope === undefined) {
    const unconditional = [...cpmMap.unconditional.keys()].some(
      (id) => id.toLowerCase() === request.PackageId.toLowerCase()
    );
    if (unconditional) {
      scope = "unconditional";
    } else if (conditionalGroups.length === 1 && conditionalGroups[0]) {
      condition = conditionalGroups[0].condition;
      scope = "group";
    } else {
      throw new Error(
        `Package ${request.PackageId} has multiple framework-scoped versions; specify CpmCondition.`
      );
    }
  }

  return {
    condition,
    scope: scope ?? (condition ? "group" : "unconditional"),
  };
}

async function applyConsolidationAddsAsync(
  request: ConsolidateRequest,
  nonCpmProjects: string[],
  signal: AbortSignal | undefined
): Promise<void> {
  const skipRestoreConfig = getSetting<boolean>("skipRestore", false);
  for (const projectPath of nonCpmProjects) {
    await executeAddPackageAsync(
      request.PackageId,
      projectPath,
      request.TargetVersion,
      skipRestoreConfig,
      undefined,
      undefined,
      signal
    );
  }
}

async function restoreConsolidatedProjectsAsync(
  request: ConsolidateRequest,
  report: JobReporter
): Promise<void> {
  if (getSetting<boolean>("skipRestore", false)) return;

  report("Restoring projects…", 70);
  for (const [i, projectPath] of request.ProjectPaths.entries()) {
    report(
      `Restoring project ${i + 1}/${request.ProjectPaths.length}…`,
      70 + (i / Math.max(1, request.ProjectPaths.length)) * 25
    );
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      ["restore", projectPath.replace(/\\/g, "/")],
      `restore-${request.PackageId}`,
      undefined,
      undefined,
      undefined,
      CreateDotnetOptions(projectPath)
    );
  }
}

/**
 * Maps a restore failure back to the batch rows that most likely caused it.
 *
 * `dotnet restore` names the contested package and the dependency chains that
 * pin it. Any requested package that appears in either place is a suspect, so
 * the UI can offer "retry without these" instead of making the user re-select
 * 60 packages by hand.
 */
function attributeRestoreConflicts(
  failure: RestoreFailure | null,
  updates: BatchUpdateRequest["Updates"]
): string[] {
  if (!failure) return [];

  const requested = new Map(updates.map((update) => [update.PackageId.toLowerCase(), update.PackageId]));
  if (requested.size === 0) return [];

  const named = collectNamedPackages(failure);
  const suspects: string[] = [];
  for (const id of named) {
    const requestedId = requested.get(id);
    if (requestedId && !suspects.includes(requestedId)) suspects.push(requestedId);
  }
  return suspects;
}

function collectNamedPackages(failure: RestoreFailure): Set<string> {
  const named = new Set<string>();
  for (const conflict of failure.conflicts) {
    if (conflict.PackageId) named.add(conflict.PackageId.toLowerCase());
    for (const chain of conflict.Chains) {
      // Chains look like "Project -> Package 1.2.3 -> Other (>= 1.0)".
      for (const match of chain.matchAll(/([A-Za-z][\w.-]{0,99})\s+v?\d+\.\d+/g)) {
        const candidate = match[1] ?? "";
        if (candidate) named.add(candidate.toLowerCase());
      }
    }
  }
  return named;
}

/**
 * Checks the whole selected set against the dependency graph before anything is
 * written.
 *
 * Two directions matter:
 * 1. the ranges declared by each selected package's *new* version, evaluated
 *    against the versions the batch will leave in the graph;
 * 2. the ranges installed packages declare on the selected packages (skipping
 *    blockers that are themselves being updated, since their new metadata is
 *    already covered by (1)).
 *
 * Without a restored project (`project.assets.json`) there is no graph to check
 * against, so no conflict is reported; `dotnet restore` stays the authority.
 */
async function findBatchUpdateConflictsAsync(
  request: BatchUpdateRequest,
  signal?: AbortSignal
): Promise<BatchUpdateConflict[]> {
  const updates = request.Updates.filter((update) => update.Version);
  if (updates.length === 0) return [];

  const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(getWorkspaceRoots());
  const detailsCache = new Map<string, Promise<Record<string, PackageDependency[]> | null>>();
  const conflicts: BatchUpdateConflict[] = [];
  const seen = new Set<string>();
  const addConflict = (conflict: BatchUpdateConflict): void => {
    // The TFM is part of the identity: one package can be required at different
    // versions per target framework, and the plan needs both.
    const key = `${conflict.PackageId.toLowerCase()}|${conflict.BlockedByPackageId.toLowerCase()}|${conflict.RequiredRange}|${conflict.Tfm ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    conflicts.push(conflict);
  };

  for (const [projectPath, selected] of buildSelectedByProject(updates)) {
    if (signal?.aborted) break;
    await checkProjectConflictsAsync({ projectPath, selected, sources, detailsCache, signal, addConflict });
  }

  await ApplyRequirementOrderAsync(conflicts);
  return conflicts;
}

interface ProjectConflictInput {
  projectPath: string;
  selected: Map<string, { id: string; version: string }>;
  sources: Array<{ Url: string; Username?: string; Password?: string }>;
  detailsCache: Map<string, Promise<Record<string, PackageDependency[]> | null>>;
  signal: AbortSignal | undefined;
  addConflict: (conflict: BatchUpdateConflict) => void;
}

async function checkProjectConflictsAsync(input: ProjectConflictInput): Promise<void> {
  const { projectPath, selected } = input;
  const graph = await loadProjectDependencyGraphAsync(projectPath);
  // Without a restored graph there is nothing to compare a single update
  // against; only a multi-package selection can still conflict with itself.
  if (!graph && selected.size < 2) return;

  const effective = new Map(graph?.packageVersions ?? []);
  for (const [id, entry] of selected) effective.set(id, entry.version);

  const restored = await coreProcess.CallAsync<RestoredDirectDependenciesWire>(
    "getRestoredDirectDependencies",
    { projectPath },
    input.signal
  );
  const tfms = [...(graph?.tfms ?? [])];
  const cpmMap = await CpmReader.GetFrameworkPackageMapAsync(projectPath);
  const centralIds = cpmMap ? CpmReader.PackageIds(cpmMap) : new Set<string>();
  const shared = {
    projectPath,
    selected,
    effective,
    ...BuildConflictConstraints(tfms, restored, centralIds, projectPath),
    sources: input.sources,
    detailsCache: input.detailsCache,
    signal: input.signal,
    addConflict: input.addConflict,
  };

  await checkSelectedPackageRangesAsync({ ...shared, tfms });
  if (graph) await checkInstalledPackageRangesAsync({ ...shared, graph });
}

function BuildConflictConstraints(
  tfms: string[],
  restored: RestoredDirectDependenciesWire,
  centralIds: Set<string>,
  projectPath: string
): Omit<ConflictCheckContext, "projectPath" | "selected" | "effective" | "sources" | "detailsCache" | "signal" | "addConflict"> {
  return {
    directPackages: new Map(
      tfms.map((tfm) => [tfm, new Set(restored.DirectByTfm[tfm] ?? [])])
    ),
    centralIds: new Set([...centralIds].map((id) => id.toLowerCase())),
    centralTransitivePinning: isCentralTransitivePinningEnabled(projectPath),
    directKnown: restored.HasDirectSection,
  };
}

/** Adds the dependency step to each conflict so the plan can be applied in order. */
async function ApplyRequirementOrderAsync(conflicts: BatchUpdateConflict[]): Promise<void> {
  if (conflicts.length === 0) return;
  const order = await coreProcess.CallAsync<{ orders: Record<string, { Order: number }> }>(
    "orderRequirements",
    {
      conflicts: conflicts.map((conflict) => ({
        packageId: conflict.BlockedByPackageId,
        requiredBy: conflict.PackageId,
        requiredByVersion: conflict.RequestedVersion,
        range: conflict.RequiredRange,
        requiredVersion: conflict.RequiredVersion ?? conflict.RequiredRange,
        tfm: conflict.Tfm ?? "",
      })),
    }
  );
  for (const conflict of conflicts) {
    const entry = order.orders[conflict.BlockedByPackageId.toLowerCase()];
    if (entry) conflict.Order = entry.Order;
  }
}

function buildSelectedByProject(
  updates: BatchUpdateRequest["Updates"]
): Map<string, Map<string, { id: string; version: string }>> {
  const selectedByProject = new Map<string, Map<string, { id: string; version: string }>>();
  for (const update of updates) {
    for (const projectPath of update.ProjectPaths) {
      const selected = selectedByProject.get(projectPath) ?? new Map<string, { id: string; version: string }>();
      selected.set(update.PackageId.toLowerCase(), { id: update.PackageId, version: update.Version });
      selectedByProject.set(projectPath, selected);
    }
  }
  return selectedByProject;
}

type ConflictCheckContext = {
  projectPath: string;
  /** Direct package ids per target framework (lower-cased). */
  directPackages: Map<string, Set<string>>;
  /** Central `PackageVersion` ids (lower-cased). */
  centralIds: Set<string>;
  /** `CentralPackageTransitivePinningEnabled` in Directory.Packages.props. */
  centralTransitivePinning: boolean;
  /**
   * False when the assets file carries no direct-dependency section, so the
   * direct/transitive split is unknown and every requirement must be reported.
   */
  directKnown: boolean;
  selected: Map<string, { id: string; version: string }>;
  effective: Map<string, string>;
  sources: Array<{ Url: string; Username?: string; Password?: string }>;
  detailsCache: Map<string, Promise<Record<string, PackageDependency[]> | null>>;
  signal: AbortSignal | undefined;
  addConflict: (conflict: BatchUpdateConflict) => void;
};

type RestoredDirectDependenciesWire = {
  DirectByTfm: Record<string, string[]>;
  HasDirectSection: boolean;
};

type ClosureConflictWire = {
  PackageId: string;
  RequiredByVersion: string;
  RequiredBy: string;
  Range: string;
  RequiredVersion: string;
  Tfm: string;
};

type ClosureResultWire = {
  Conflicts: ClosureConflictWire[];
  Planned: Record<string, string>;
};

async function checkSelectedPackageRangesAsync(
  context: ConflictCheckContext & { tfms: string[] }
): Promise<void> {
  // (1) Ranges declared by the selected versions *and* by everything those
  // requirements pull in — a one-level check reports an incomplete plan.
  const constrained: Record<string, string[]> = {};
  for (const tfm of context.tfms) {
    // Only a direct reference or a transitive pin can hold a package back; a
    // purely transitive package is resolved upward by NuGet.
    const ids = new Set(context.selected.keys());
    if (context.directKnown) {
      for (const id of context.directPackages.get(tfm) ?? []) ids.add(id);
      if (context.centralTransitivePinning) {
        for (const id of context.centralIds) ids.add(id);
      }
    }
    constrained[tfm] = [...ids];
  }

  const proxy = ReadProxyUrl();
  const closure = await coreProcess.CallAsync<ClosureResultWire>(
    "computeRequirementClosure",
    {
      selected: [...context.selected.values()].map((entry) => ({
        id: entry.id,
        version: entry.version,
      })),
      tfms: context.tfms,
      effective: Object.fromEntries(context.effective),
      constrained,
      constrainAll: !context.directKnown,
      maxInspected: 250,
      sources: context.sources.map((source) => ({
        url: source.Url,
        ...(source.Username !== undefined && { username: source.Username }),
        ...(source.Password !== undefined && { password: source.Password }),
        ...(proxy !== undefined && { proxy }),
      })),
    },
    context.signal
  );

  for (const conflict of closure.Conflicts) {
    const resolved = context.effective.get(conflict.PackageId.toLowerCase()) ?? conflict.RequiredVersion;
    context.addConflict({
      PackageId: conflict.RequiredBy,
      RequestedVersion: conflict.RequiredByVersion,
      BlockedByPackageId: conflict.PackageId,
      BlockedByVersion: resolved,
      RequiredRange: conflict.Range,
      RequiredVersion: conflict.RequiredVersion,
      Tfm: conflict.Tfm,
      EffectiveVersion: resolved,
      ProjectPath: context.projectPath,
      Reason: `${conflict.RequiredBy} ${conflict.RequiredByVersion} requires ${conflict.PackageId} ${conflict.Range}, but the graph resolves ${resolved}`,
    });
  }
}

async function checkInstalledPackageRangesAsync(
  context: ConflictCheckContext & { graph: ProjectDependencyGraph }
): Promise<void> {
  // (2) Ranges installed packages declare on the selected packages.
  const group: InstalledPackageGroup = {
    tfms: new Set(context.graph.tfms),
    projectPaths: new Set([context.projectPath]),
    direct: await buildDirectPackagesAsync(context.projectPath),
  };
  const constraintsByPackage = await collectGroupConstraintsAsync(
    [...context.selected.keys()],
    group,
    context.sources,
    context.detailsCache,
    context.signal
  );

  for (const [candidateId, constraints] of constraintsByPackage) {
    const entry = context.selected.get(candidateId);
    if (!entry) continue;
    const resolved = context.effective.get(candidateId) ?? entry.version;

    for (const constraint of constraints) {
      if (context.selected.has(constraint.PackageId.toLowerCase())) continue;
      if (satisfiesVersionRange(resolved, constraint.Range)) continue;
      context.addConflict({
        PackageId: entry.id,
        RequestedVersion: entry.version,
        BlockedByPackageId: constraint.PackageId,
        BlockedByVersion: constraint.InstalledVersion,
        RequiredRange: constraint.Range,
        EffectiveVersion: resolved,
        ProjectPath: context.projectPath,
        Reason: `${constraint.PackageId} ${constraint.InstalledVersion} requires ${entry.id} ${constraint.Range}`,
      });
    }
  }
}

async function buildDirectPackagesAsync(
  projectPath: string
): Promise<Map<string, { id: string; versions: Set<string> }>> {
  const direct = new Map<string, { id: string; versions: Set<string> }>();
  try {
    const parsedProject = await parseProjectAsync(projectPath);
    for (const pkg of parsedProject.Packages) {
      direct.set(pkg.Id.toLowerCase(), { id: pkg.Id, versions: new Set([pkg.Version]) });
    }
  } catch (err) {
    Logger.debug(`checkBatchUpdate: could not parse ${projectPath} for display names`, err);
  }
  return direct;
}

async function searchAcrossSourcesAsync(
  sources: Array<{ Url: string }>,
  request: GetPackagesRequest,
  signal?: AbortSignal
): Promise<Package[]> {
  let completed = 0;
  const promises = sources.map(async (source) => {
    try {
      const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
      const result = await api.GetPackagesAsync(
        request.Filter,
        request.Prerelease,
        request.Skip,
        request.Take,
        signal
      );
      // A search result is shown without a single selected source; carry the source that
      // produced it so the Details panel can load dependencies.
      for (const pkg of result.data) {
        pkg.SourceUrl = source.Url;
      }
      return result;
    } catch (error) {
      Logger.error(`getPackages: Failed to fetch from ${source.Url}`, error);
      return { data: [] as Package[] };
    } finally {
      completed++;
      StatusBarUtils.show((completed / sources.length) * 100, "Loading packages...");
    }
  });

  const results = await Promise.all(promises);
  const keptById = new Map<string, Package>();
  for (const result of results) {
    for (const pkg of result.data) {
      const kept = keptById.get(pkg.Id);
      if (!kept) {
        keptById.set(pkg.Id, pkg);
        continue;
      }

      // The first feed to answer keeps the row; a later one only lends popularity
      // data when the kept copy has none. Versions and description stay put.
      if (kept.TotalDownloads === null) {
        MergePopularityDownloadCounts(kept, pkg);
      }
    }
  }
  return [...keptById.values()];
}

/**
 * Copies popularity metadata from `donor` onto `target` in place, without touching the
 * identity of the row: versions keep their list, and only their per-version counts are
 * filled where the donor knows a version the target already has.
 *
 * Returns false when the donor publishes no total, i.e. it has nothing to lend.
 */
function MergePopularityDownloadCounts(target: Package, donor: Package): boolean {
  if (donor.TotalDownloads === null) return false;

  target.TotalDownloads = donor.TotalDownloads;
  target.Verified = donor.Verified;

  const donorDownloads = new Map<string, number | null>();
  for (const version of donor.Versions) {
    donorDownloads.set(version.Version.toLowerCase(), version.Downloads ?? null);
  }

  for (const version of target.Versions) {
    const downloads = donorDownloads.get(version.Version.toLowerCase());
    if (downloads !== undefined && downloads !== null) {
      version.Downloads = downloads;
    }
  }

  return true;
}

async function fetchPackagesFromUrlAsync(
  url: string,
  request: GetPackagesRequest,
  signal?: AbortSignal
): Promise<{ data: Package[] }> {
  Logger.info(`getPackages: Fetching from ${url} with filter '${request.Filter}'`);
  const api = await nugetApiFactory.GetSourceApiAsync(url);
  const packages = await api.GetPackagesAsync(
    request.Filter,
    request.Prerelease,
    request.Skip,
    request.Take,
    signal
  );
  for (const pkg of packages.data) {
    pkg.SourceUrl = url;
  }
  Logger.info(`getPackages: Successfully fetched ${packages.data.length} packages`);
  return packages;
}

async function fetchPackageFromAnySourceAsync(
  request: GetPackageRequest,
  signal?: AbortSignal
): Promise<Result<GetPackageResponse>> {
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

  let primary: GetPackageResponse | undefined;
  let primaryIndex = -1;

  for (const [index, source] of sources.entries()) {
    try {
      const result = await fetchPackageFromSourceAsync(source.Url, request, signal);
      if (!result.ok) {
        Logger.warn(`getPackage: ${request.Id} not in ${source.Url}, trying next`);
        continue;
      }

      // A feed that publishes popularity data is the whole answer; the source badge
      // and version list stay its own.
      if (result.value.Package.TotalDownloads !== null) return result;
      primary = result.value;
      primaryIndex = index;
      break;
    } catch {
      Logger.warn(`getPackage: ${request.Id} not in ${source.Url}, trying next`);
    }
  }

  if (primary === undefined) {
    return fail("Failed to fetch package from any source");
  }

  // The serving feed has no download data (an offline folder feed, for example):
  // another configured feed that knows the package lends its popularity counts.
  await mergePopularityFromRemainingSourcesAsync(primary, sources, primaryIndex + 1, request, signal);
  return ok(primary);
}

async function mergePopularityFromRemainingSourcesAsync(
  primary: GetPackageResponse,
  sources: Array<{ Url: string }>,
  startIndex: number,
  request: GetPackageRequest,
  signal?: AbortSignal
): Promise<void> {
  for (const source of sources.slice(startIndex)) {
    try {
      const donor = await fetchPackageFromSourceAsync(source.Url, request, signal);
      if (donor.ok && MergePopularityDownloadCounts(primary.Package, donor.value.Package)) {
        return;
      }
    } catch {
      Logger.warn(`getPackage: ${request.Id} has no popularity data in ${source.Url}`);
    }
  }
}

async function fetchPackageFromSourceAsync(
  url: string,
  request: GetPackageRequest,
  signal?: AbortSignal
): Promise<Result<GetPackageResponse>> {
  const api = await nugetApiFactory.GetSourceApiAsync(url);
  if (request.ForceReload) {
    api.ClearPackageCache(request.Id);
  }
  const packageResult = await api.GetPackageAsync(request.Id, request.Prerelease, signal);
  if (packageResult.isError || !packageResult.data) {
    return fail("Failed to fetch package");
  }
  return ok({ Package: packageResult.data, SourceUrl: url });
}

function createScanReporter(scanId: string | undefined) {
  return (stage: string, percent: number, completed = 0, total = 0): void => {
    if (scanId) ScanProgress.Report(scanId, stage, percent, completed, total);
  };
}

async function validateOutdatedRequestAsync(request: GetOutdatedPackagesRequest): Promise<string | null> {
  if (!request.ProjectPaths?.length) return null;
  const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
  return outsideWorkspace ? `Project path is outside the workspace: ${outsideWorkspace}` : null;
}

type PreparedOutdatedScan =
  | { kind: "empty" }
  | { kind: "cached"; cached: GetOutdatedPackagesResponse }
  | {
      kind: "ready";
      sources: Array<{ Name: string; Url: string; Patterns?: string[] }>;
      settings: ReturnType<typeof getCpmSettings>;
      cacheKey: string;
      projectFiles: Array<{ fsPath: string }>;
    };

async function prepareOutdatedScanAsync(
  request: GetOutdatedPackagesRequest,
  scanCache: ScanCacheStore,
  report: (stage: string, percent: number, completed?: number, total?: number) => void
): Promise<PreparedOutdatedScan> {
  const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
  let sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);
  if (request.SourceUrl) {
    sources = sources.filter((source) => source.Url === request.SourceUrl);
  }
  if (sources.length === 0) return { kind: "empty" };

  const settings = getCpmSettings();
  const cacheKey = BuildScanCacheKey({
    workspaceRoots,
    projectPaths: request.ProjectPaths ?? [],
    sourceUrls: sources.map((source) => source.Url),
    prerelease: request.Prerelease,
    excludeGlobs: settings.excludeGlobs,
  });

  if (request.PreferCache && !request.ForceReload) {
    const cached = await scanCache.LoadAsync(cacheKey);
    return { kind: "cached", cached: buildCachedOutdatedResponse(cached) };
  }

  report("Reading project files…", 4);
  let projectFiles = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);
  if (request.ProjectPaths?.length) {
    projectFiles = projectFiles.filter((file) => request.ProjectPaths!.includes(file.fsPath));
  }

  return { kind: "ready", sources, settings, cacheKey, projectFiles };
}

function buildCachedOutdatedResponse(
  cached: Awaited<ReturnType<ScanCacheStore["LoadAsync"]>>
): GetOutdatedPackagesResponse {
  if (!cached) return { Packages: [], FromCache: true };
  const response: GetOutdatedPackagesResponse = {
    Packages: cached.Packages,
    FromCache: true,
    ScannedAt: cached.ScannedAt,
  };
  if (cached.BlockedPackages.length > 0) response.BlockedPackages = cached.BlockedPackages;
  Logger.info(`getOutdatedPackages: Served ${cached.Packages.length} package(s) from the last scan`);
  return response;
}

async function parseOutdatedProjectsAsync(
  projectFiles: Array<{ fsPath: string }>,
  report: (stage: string, percent: number, completed?: number, total?: number) => void
): Promise<Project[]> {
  const parseStarted = Date.now();
  const totalProjects = projectFiles.length;
  report(`Parsing projects (0/${totalProjects})…`, 4, 0, totalProjects);

  // Batched so the progress bar still moves; the core parses each batch in one round trip.
  const chunkSize = Math.max(1, Math.ceil(totalProjects / 10));
  const projects: Project[] = [];

  for (let index = 0; index < totalProjects; index += chunkSize) {
    const chunk = projectFiles.slice(index, index + chunkSize);
    const parsed = await parseProjectsAsync(chunk.map((file) => file.fsPath));
    projects.push(...parsed);

    const completed = Math.min(totalProjects, index + chunk.length);
    report(
      `Parsing projects (${completed}/${totalProjects})…`,
      4 + (26 * completed) / Math.max(1, totalProjects),
      completed,
      totalProjects
    );
  }

  if (projects.length !== totalProjects) {
    Logger.debug(`getOutdatedPackages: ${totalProjects - projects.length} project(s) could not be parsed`);
  }

  const tfmSources = new Map<string, number>();
  for (const project of projects) {
    const source = project.TfmSource ?? "unknown";
    tfmSources.set(source, (tfmSources.get(source) ?? 0) + 1);
  }
  const tfmSourceSummary =
    [...tfmSources].map(([source, count]) => `${source}=${count}`).join(", ") || "none";
  Logger.info(
    `getOutdatedPackages: Parsed ${projects.length} project(s) in ${Date.now() - parseStarted}ms` +
    ` (TFM sources: ${tfmSourceSummary})`
  );
  return projects;
}

type InstalledState = {
  installedMap: Map<string, InstalledPackageEntry>;
  groups: Map<string, InstalledPackageGroup>;
};

function buildInstalledState(projects: Project[]): InstalledState {
  const installedMap = new Map<string, InstalledPackageEntry>();
  const groups = new Map<string, InstalledPackageGroup>();
  for (const project of projects) {
    for (const pkg of project.Packages) {
      addInstalledPackage(project, pkg, installedMap, groups);
    }
  }
  return { installedMap, groups };
}

function addInstalledPackage(
  project: Project,
  pkg: ProjectPackage,
  installedMap: Map<string, InstalledPackageEntry>,
  groups: Map<string, InstalledPackageGroup>
): void {
  if (pkg.IsPinned) return;

  // A package with framework-scoped versions intentionally has no single
  // `pkg.Version`; use its per-TFM resolutions instead of dropping it.
  const resolutions = pkg.CpmResolutions?.length
    ? pkg.CpmResolutions
    : [{
        Tfm: "",
        Version: pkg.Version,
        Condition: "",
        ConditionLabel: "",
        Matched: true,
      }];

  for (const resolution of resolutions) {
    if (!resolution.Version) continue;
    mergeInstalledEntry(project, pkg, resolution, installedMap);
    addInstalledGroupEntry(project, pkg, resolution, groups);
  }
}

function mergeInstalledEntry(
  project: Project,
  pkg: ProjectPackage,
  resolution: { Tfm: string; Version: string; Condition: string; ConditionLabel: string; Matched: boolean },
  installedMap: Map<string, InstalledPackageEntry>
): void {
  const key = `${pkg.Id}\0${resolution.Condition}`;
  const existing = installedMap.get(key);
  const projectInfo = { Name: project.Name, Path: project.Path, Version: resolution.Version };

  if (existing) {
    existing.projects.push(projectInfo);
    existing.matched = existing.matched && resolution.Matched;
    if (compareVersions(resolution.Version, existing.version) < 0) {
      existing.version = resolution.Version;
    }
    return;
  }

  installedMap.set(key, {
    version: resolution.Version,
    condition: resolution.Condition,
    framework: resolution.Tfm,
    conditionLabel: resolution.ConditionLabel,
    matched: resolution.Matched,
    projects: [projectInfo],
  });
}

function addInstalledGroupEntry(
  project: Project,
  pkg: ProjectPackage,
  resolution: { Tfm: string; Version: string; Condition: string },
  groups: Map<string, InstalledPackageGroup>
): void {
  let group = groups.get(resolution.Condition);
  if (!group) {
    group = { tfms: new Set(), projectPaths: new Set(), direct: new Map() };
    groups.set(resolution.Condition, group);
  }

  const idKey = pkg.Id.toLowerCase();
  let direct = group.direct.get(idKey);
  if (!direct) {
    direct = { id: pkg.Id, versions: new Set() };
    group.direct.set(idKey, direct);
  }
  direct.versions.add(resolution.Version);
  group.projectPaths.add(project.Path);
  if (resolution.Tfm) group.tfms.add(resolution.Tfm);
  for (const tfm of project.TargetFrameworks ?? []) group.tfms.add(tfm);
}

type OutdatedCandidateParams = {
  installedMap: Map<string, InstalledPackageEntry>;
  sources: Array<{ Name: string; Url: string; Patterns?: string[] }>;
  request: GetOutdatedPackagesRequest;
  settings: ReturnType<typeof getCpmSettings>;
  signal: AbortSignal | undefined;
  report: (stage: string, percent: number, completed?: number, total?: number) => void;
};

async function collectOutdatedCandidatesAsync(params: OutdatedCandidateParams): Promise<OutdatedCandidate[]> {
  const installedKeys = Array.from(params.installedMap.keys());
  const configuredConcurrency = getSetting<number>("updateCheckConcurrency", 8);
  const batchSize = Number.isFinite(configuredConcurrency)
    ? Math.min(32, Math.max(1, Math.trunc(configuredConcurrency)))
    : 8;
  const latestCache = new Map<string, Promise<Awaited<ReturnType<typeof getLatestVersionAsync>>>>();
  const candidates: OutdatedCandidate[] = [];
  const latestStarted = Date.now();
  params.report(`Checking latest versions (0/${installedKeys.length})…`, 30, 0, installedKeys.length);

  for (let i = 0; i < installedKeys.length; i += batchSize) {
    if (params.signal?.aborted) break;
    const batch = installedKeys.slice(i, i + batchSize);
    const checked = i + batch.length;
    const progress = Math.round((checked / installedKeys.length) * 100);
    StatusBarUtils.show(progress, `Checking updates (${checked}/${installedKeys.length})...`);
    params.report(
      `Checking latest versions (${checked}/${installedKeys.length})…`,
      30 + (60 * checked) / Math.max(1, installedKeys.length),
      checked,
      installedKeys.length
    );

    await Promise.allSettled(
      batch.map((key) => buildOutdatedCandidateAsync(key, params, latestCache, candidates))
    );
  }

  Logger.info(
    `getOutdatedPackages: Latest-version checks took ${Date.now() - latestStarted}ms for ${installedKeys.length} package(s)`
  );
  return candidates;
}

async function buildOutdatedCandidateAsync(
  key: string,
  params: OutdatedCandidateParams,
  latestCache: Map<string, Promise<Awaited<ReturnType<typeof getLatestVersionAsync>>>>,
  candidates: OutdatedCandidate[]
): Promise<void> {
  if (params.signal?.aborted) return;
  const installed = params.installedMap.get(key)!;
  // Extract the real package ID from the composite key (before the null-byte separator)
  const packageId = key.split("\0")[0]!;
  const lookupKey = `${packageId}\0${params.request.Prerelease}`;
  if (!latestCache.has(lookupKey)) {
    latestCache.set(
      lookupKey,
      getLatestVersionAsync(packageId, params.request.Prerelease, params.sources, params.signal)
    );
  }
  const latest = await latestCache.get(lookupKey)!;
  if (params.signal?.aborted) return;
  if (!latest || compareVersions(latest.version, installed.version) <= 0) return;

  const available = selectAvailableVersions(latest, installed, packageId, params.settings);
  if (available.length === 0) return;
  candidates.push({ packageId, installed, latest, available });
}

function selectAvailableVersions(
  latest: { version: string; versions: string[] },
  installed: InstalledPackageEntry,
  packageId: string,
  settings: ReturnType<typeof getCpmSettings>
): string[] {
  const tfmMajor = installed.framework ? getTfmMajorVersion(installed.framework) : null;
  const aligned = tfmMajor !== null && isFrameworkAlignedPackage(packageId, settings.alignedPatterns);
  // Search results occasionally omit the version list; the reported latest
  // version must still be considered.
  const allVersions = latest.versions.length > 0 ? latest.versions : [latest.version];
  const alignedVersions = tfmMajor !== null && aligned
    ? allVersions.filter((version) => getVersionMajor(version) === tfmMajor)
    : allVersions;
  // Keep the historical fallback: when the TFM's major line has no newer
  // version, the overall latest is still offered instead of hiding the update.
  const pool = alignedVersions.some((version) => compareVersions(version, installed.version) > 0)
    ? alignedVersions
    : allVersions;
  return pool
    .filter((version) => compareVersions(version, installed.version) > 0)
    .sort(compareVersions);
}

type OutdatedConstraintParams = {
  candidates: OutdatedCandidate[];
  groups: Map<string, InstalledPackageGroup>;
  sources: Array<{ Url: string }>;
  signal: AbortSignal | undefined;
  report: (stage: string, percent: number, completed?: number, total?: number) => void;
};

async function applyOutdatedConstraintsAsync(
  params: OutdatedConstraintParams
): Promise<{ outdated: OutdatedPackage[]; blocked: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]> }> {
  const outdated: OutdatedPackage[] = [];
  const blocked: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]> = [];
  const dependencyDetailsCache = new Map<string, Promise<Record<string, PackageDependency[]> | null>>();
  const candidatesByCondition = groupCandidatesByCondition(params.candidates);

  const constraintStarted = Date.now();
  const totalConditions = candidatesByCondition.size;
  let completedConditions = 0;
  params.report(`Checking dependency constraints (0/${totalConditions})…`, 90, 0, totalConditions);

  for (const [condition, conditionCandidates] of candidatesByCondition) {
    if (params.signal?.aborted) break;
    const constraintsByPackage = await collectGroupConstraintsAsync(
      conditionCandidates.map((candidate) => candidate.packageId),
      params.groups.get(condition),
      params.sources,
      dependencyDetailsCache,
      params.signal
    );
    completedConditions += 1;
    params.report(
      `Checking dependency constraints (${completedConditions}/${totalConditions})…`,
      90 + (8 * completedConditions) / Math.max(1, totalConditions),
      completedConditions,
      totalConditions
    );

    for (const candidate of conditionCandidates) {
      const constraints = constraintsByPackage.get(candidate.packageId.toLowerCase()) ?? [];
      applyCandidateConstraints(candidate, constraints, outdated, blocked);
    }
  }

  outdated.sort((a, b) => a.Id.localeCompare(b.Id));
  blocked.sort((a, b) => a.Id.localeCompare(b.Id));
  params.report("Preparing results…", 99);
  Logger.info(
    `getOutdatedPackages: Dependency-constraint checks took ${Date.now() - constraintStarted}ms`
  );
  return { outdated, blocked };
}

function groupCandidatesByCondition(candidates: OutdatedCandidate[]): Map<string, OutdatedCandidate[]> {
  const byCondition = new Map<string, OutdatedCandidate[]>();
  for (const candidate of candidates) {
    const list = byCondition.get(candidate.installed.condition) ?? [];
    list.push(candidate);
    byCondition.set(candidate.installed.condition, list);
  }
  return byCondition;
}

function applyCandidateConstraints(
  candidate: OutdatedCandidate,
  constraints: PackageConstraint[],
  outdated: OutdatedPackage[],
  blocked: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>
): void {
  const latestAvailable = candidate.available[candidate.available.length - 1]!;
  const satisfying = constraints.length === 0
    ? latestAvailable
    : findLatestSatisfyingVersion(candidate.available, constraints);

  if (!satisfying || compareVersions(satisfying, candidate.installed.version) <= 0) {
    blocked.push(buildBlockedEntry(candidate, constraints, latestAvailable));
    return;
  }

  outdated.push(buildOutdatedEntry(candidate, constraints, satisfying));
}

function buildBlockedEntry(
  candidate: OutdatedCandidate,
  constraints: PackageConstraint[],
  latestAvailable: string
): NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>[number] {
  const reason = formatConstraintReason(constraints);
  Logger.info(
    `getOutdatedPackages: Holding ${candidate.packageId} at ${candidate.installed.version} — ${reason}`
  );
  return {
    Id: candidate.packageId,
    InstalledVersion: candidate.installed.version,
    BlockedVersion: latestAvailable,
    Reason: reason,
    BlockedBy: constraints.map((constraint) => ({
      PackageId: constraint.PackageId,
      InstalledVersion: constraint.InstalledVersion,
      Range: constraint.Range,
    })),
  };
}

function buildOutdatedEntry(
  candidate: OutdatedCandidate,
  constraints: PackageConstraint[],
  satisfying: string
): OutdatedPackage {
  const entry: OutdatedPackage = {
    Id: candidate.packageId,
    InstalledVersion: candidate.installed.version,
    LatestVersion: satisfying,
    Projects: candidate.installed.projects,
    SourceUrl: candidate.latest.sourceUrl,
    SourceName: candidate.latest.sourceName,
    TotalDownloads: candidate.latest.totalDownloads ?? null,
    Verified: candidate.latest.verified ?? null,
  };
  const installed = candidate.installed;
  if (installed.condition) entry.CpmCondition = installed.condition;
  if (installed.framework) entry.CpmFramework = installed.framework;
  if (installed.conditionLabel) entry.CpmConditionLabel = installed.conditionLabel;
  if (!installed.matched) entry.CpmMatched = false;
  if (compareVersions(candidate.latest.version, satisfying) > 0) {
    entry.LatestOverallVersion = candidate.latest.version;
  }

  const violated = constraints.filter(
    (constraint) => !satisfiesVersionRange(candidate.latest.version, constraint.Range)
  );
  if (violated.length > 0) {
    entry.BlockedBy = violated.map((constraint) => ({
      PackageId: constraint.PackageId,
      InstalledVersion: constraint.InstalledVersion,
      Range: constraint.Range,
    }));
  }
  return entry;
}

async function saveOutdatedScanAsync(
  scanCache: ScanCacheStore,
  cacheKey: string,
  outdated: OutdatedPackage[],
  blocked: NonNullable<GetOutdatedPackagesResponse["BlockedPackages"]>
): Promise<void> {
  await scanCache.SaveAsync({
    Key: cacheKey,
    ScannedAt: new Date().toISOString(),
    Packages: outdated,
    BlockedPackages: blocked,
  });
}

async function validateProjectPathsAsync(projectPaths: string[] | undefined): Promise<string | null> {
  if (!projectPaths?.length) return null;
  const outsideWorkspace = await findOutsideWorkspaceAsync(projectPaths);
  return outsideWorkspace ? `Project path is outside the workspace: ${outsideWorkspace}` : null;
}

async function findScanProjectFilesAsync(
  projectPaths: string[] | undefined,
  excludeGlobs: string[]
): Promise<Array<{ fsPath: string }>> {
  let projectFiles = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  projectFiles = applyExcludeGlobs(projectFiles, excludeGlobs);
  if (projectPaths?.length) {
    projectFiles = projectFiles.filter((file) => projectPaths.includes(file.fsPath));
  }
  return projectFiles;
}

async function parseProjectsForScanAsync(
  projectFiles: Array<{ fsPath: string }>,
  logLabel: string
): Promise<{ projects: Project[]; anyCpmEnabled: boolean }> {
  const projects = await parseProjectsAsync(projectFiles.map((file) => file.fsPath));

  if (projects.length !== projectFiles.length) {
    Logger.debug(`${logLabel}: ${projectFiles.length - projects.length} project(s) could not be parsed`);
  }

  return { projects, anyCpmEnabled: projects.some((project) => project.CpmEnabled) };
}

type ConsistencyEntry = {
  packageId: string;
  framework: string;
  condition: string;
  conditionLabel: string;
  versions: Map<string, Array<{ Name: string; Path: string }>>;
};

function buildVersionConsistencyMap(projects: Project[]): Map<string, ConsistencyEntry> {
  // Key: "packageId\0condition\0tfm" — a package may legitimately have one
  // version per target framework; only versions inside the same framework line
  // are comparable. Never collapse net10.0 and net11.0 into one row.
  const packageMap = new Map<string, ConsistencyEntry>();
  for (const project of projects) {
    for (const pkg of project.Packages) {
      addPackageToConsistencyMap(project, pkg, packageMap);
    }
  }
  return packageMap;
}

function addPackageToConsistencyMap(
  project: Project,
  pkg: ProjectPackage,
  packageMap: Map<string, ConsistencyEntry>
): void {
  const resolutions = pkg.CpmResolutions?.length
    ? pkg.CpmResolutions
    : [{ Tfm: "", Version: pkg.Version, Condition: "", ConditionLabel: "", Matched: true }];

  for (const resolution of resolutions) {
    if (!resolution.Version) continue;
    const compositeKey = `${pkg.Id}\0${resolution.Condition}\0${resolution.Tfm}`;

    let entry = packageMap.get(compositeKey);
    if (!entry) {
      entry = {
        packageId: pkg.Id,
        framework: resolution.Tfm,
        condition: resolution.Condition,
        conditionLabel: resolution.ConditionLabel,
        versions: new Map(),
      };
      packageMap.set(compositeKey, entry);
    }

    const projects = entry.versions.get(resolution.Version) ?? [];
    projects.push({ Name: project.Name, Path: project.Path });
    entry.versions.set(resolution.Version, projects);
  }
}

function buildInconsistentPackages(
  packageMap: Map<string, ConsistencyEntry>,
  anyCpmEnabled: boolean
): InconsistentPackage[] {
  const inconsistent: InconsistentPackage[] = [];
  for (const { packageId, framework, condition, conditionLabel, versions } of packageMap.values()) {
    if (versions.size <= 1) continue;
    const rows = buildVersionRows(versions, framework, condition, conditionLabel);
    inconsistent.push({
      Id: packageId,
      Versions: rows,
      LatestInstalledVersion: rows[0]?.Version ?? "",
      CpmManaged: anyCpmEnabled,
    });
  }
  return inconsistent;
}

function buildVersionRows(
  versions: Map<string, Array<{ Name: string; Path: string }>>,
  framework: string,
  condition: string,
  conditionLabel: string
): InconsistentPackage["Versions"] {
  return Array.from(versions.entries())
    .map(([version, projects]) => ({
      Version: version,
      Projects: projects,
      ...(framework ? { CpmFramework: framework } : {}),
      ...(condition ? { CpmCondition: condition } : {}),
      ...(conditionLabel ? { CpmConditionLabel: conditionLabel } : {}),
    }))
    .sort((a, b) => compareVersions(b.Version, a.Version));
}

async function clearVulnerabilityCachesAsync(sources: Array<{ Url: string }>): Promise<void> {
  for (const source of sources) {
    const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
    api.ClearVulnerabilityCache();
  }
}

type VulnerableInstalledEntry = {
  id: string;
  version: string;
  projects: Array<{ Name: string; Path: string }>;
  frameworks: Set<string>;
  direct: boolean;
  dependencyOf: Set<string>;
};

type VulnerabilityAssets = {
  libraries?: Record<string, { type?: string }>;
  targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>>;
};

function buildVulnerableInstalledMap(projects: Project[]): Map<string, VulnerableInstalledEntry> {
  // Collect all installed package versions with their projects. A package can
  // have a different version per TFM, so each resolved version is scanned.
  const installedMap = new Map<string, VulnerableInstalledEntry>();
  for (const project of projects) {
    for (const pkg of project.Packages) {
      addDirectVulnerableEntries(project, pkg, installedMap);
    }
  }
  return installedMap;
}

function addDirectVulnerableEntries(
  project: Project,
  pkg: ProjectPackage,
  installedMap: Map<string, VulnerableInstalledEntry>
): void {
  const resolutions = pkg.CpmResolutions?.length
    ? pkg.CpmResolutions
    : [{ Tfm: "", Version: pkg.Version, Condition: "", ConditionLabel: "", Matched: true }];

  for (const resolution of resolutions) {
    if (!resolution.Version) continue;
    const key = `${pkg.Id.toLowerCase()}::${resolution.Version}`;
    const existing = installedMap.get(key);
    if (existing) {
      mergeDirectVulnerableEntry(existing, project, resolution.Tfm);
      continue;
    }
    installedMap.set(key, {
      id: pkg.Id,
      version: resolution.Version,
      projects: [{ Name: project.Name, Path: project.Path }],
      frameworks: new Set(resolution.Tfm ? [resolution.Tfm] : []),
      direct: true,
      dependencyOf: new Set(),
    });
  }
}

function mergeDirectVulnerableEntry(
  entry: VulnerableInstalledEntry,
  project: Project,
  tfm: string
): void {
  if (!entry.projects.some((p) => p.Path === project.Path)) {
    entry.projects.push({ Name: project.Name, Path: project.Path });
  }
  if (tfm) entry.frameworks.add(tfm);
  entry.direct = true;
}

async function addTransitivePackagesAsync(
  projects: Project[],
  installedMap: Map<string, VulnerableInstalledEntry>
): Promise<void> {
  // project.assets.json includes transitive dependencies. Scan those too so a
  // vulnerable package pulled in by another package is visible; direct
  // references still win when the same package/version appears in both.
  for (const project of projects) {
    const assetsPath = path.join(path.dirname(project.Path), "obj", "project.assets.json");
    try {
      const assets = JSON.parse(await fs.readFile(assetsPath, "utf8")) as VulnerabilityAssets;
      addAssetsLibraries(project, assets, installedMap);
    } catch {
      // No restore output (or an unreadable file): direct references only.
    }
  }
}

function addAssetsLibraries(
  project: Project,
  assets: VulnerabilityAssets,
  installedMap: Map<string, VulnerableInstalledEntry>
): void {
  const directIds = new Set(project.Packages.map((pkg) => pkg.Id.toLowerCase()));
  const parentsByChild = buildAssetsParents(assets);

  for (const [libraryKey, library] of Object.entries(assets.libraries ?? {})) {
    if (library.type !== "package") continue;
    const slash = libraryKey.lastIndexOf("/");
    if (slash <= 0) continue;

    const id = libraryKey.slice(0, slash);
    const version = libraryKey.slice(slash + 1);
    mergeTransitiveEntry(project, id, version, directIds, parentsByChild, installedMap);
  }
}

function buildAssetsParents(assets: VulnerabilityAssets): Map<string, Set<string>> {
  const parentsByChild = new Map<string, Set<string>>();
  for (const target of Object.values(assets.targets ?? {})) {
    for (const [parentKey, metadata] of Object.entries(target)) {
      const parentId = parentKey.slice(0, parentKey.lastIndexOf("/"));
      for (const childId of Object.keys(metadata.dependencies ?? {})) {
        const child = childId.toLowerCase();
        const parents = parentsByChild.get(child) ?? new Set<string>();
        parents.add(parentId);
        parentsByChild.set(child, parents);
      }
    }
  }
  return parentsByChild;
}

function mergeTransitiveEntry(
  project: Project,
  id: string,
  version: string,
  directIds: Set<string>,
  parentsByChild: Map<string, Set<string>>,
  installedMap: Map<string, VulnerableInstalledEntry>
): void {
  const mapKey = `${id.toLowerCase()}::${version}`;
  const direct = directIds.has(id.toLowerCase());
  const dependencyOf = new Set(parentsByChild.get(id.toLowerCase()) ?? []);
  const existing = installedMap.get(mapKey);

  if (existing) {
    existing.direct = existing.direct || direct;
    dependencyOf.forEach((parent) => existing.dependencyOf.add(parent));
    if (!existing.projects.some((p) => p.Path === project.Path)) {
      existing.projects.push({ Name: project.Name, Path: project.Path });
    }
    return;
  }

  installedMap.set(mapKey, {
    id,
    version,
    projects: [{ Name: project.Name, Path: project.Path }],
    frameworks: new Set(),
    direct,
    dependencyOf,
  });
}

async function fetchVulnerabilitiesAsync(
  sources: Array<{ Url: string }>,
  signal?: AbortSignal
): Promise<Map<string, VulnerabilityEntry[]>> {
  const allVulnerabilities = new Map<string, VulnerabilityEntry[]>();
  const vulnResults = await Promise.allSettled(
    sources.map(async (source) => {
      const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
      return { source, vulns: await api.GetVulnerabilitiesAsync(signal) };
    })
  );

  for (const result of vulnResults) {
    if (result.status === "fulfilled") {
      for (const [packageId, entries] of result.value.vulns) {
        const key = packageId.toLowerCase();
        const existing = allVulnerabilities.get(key) ?? [];
        existing.push(...entries);
        allVulnerabilities.set(key, existing);
      }
    } else {
      Logger.warn(`getVulnerablePackages: Failed to fetch vulns from a source`, result.reason);
    }
  }
  return allVulnerabilities;
}

function matchVulnerablePackages(
  installedMap: Map<string, VulnerableInstalledEntry>,
  allVulnerabilities: Map<string, VulnerabilityEntry[]>
): VulnerablePackage[] {
  const vulnerable: VulnerablePackage[] = [];
  for (const [key, installed] of installedMap) {
    const packageId = key.split("::")[0] ?? "";
    const vulnEntries = allVulnerabilities.get(packageId);
    if (!vulnEntries) continue;

    const worstMatch = findWorstMatch(installed.version, vulnEntries);
    if (worstMatch) vulnerable.push(buildVulnerableEntry(installed, worstMatch));
  }
  return vulnerable;
}

function findWorstMatch(
  version: string,
  entries: VulnerabilityEntry[]
): { severity: VulnerableSeverity; url: string; versions: string } | null {
  let worstMatch: { severity: VulnerableSeverity; url: string; versions: string } | null = null;
  for (const entry of entries) {
    if (!isVersionInRange(version, entry.versions)) continue;
    if (!worstMatch || entry.severity > worstMatch.severity) {
      worstMatch = entry;
    }
  }
  return worstMatch;
}

function buildVulnerableEntry(
  installed: VulnerableInstalledEntry,
  worstMatch: { severity: VulnerableSeverity; url: string; versions: string }
): VulnerablePackage {
  return {
    Id: installed.id,
    InstalledVersion: installed.version,
    Severity: worstMatch.severity,
    AdvisoryUrl: worstMatch.url,
    AffectedVersionRange: worstMatch.versions,
    Projects: installed.projects,
    ...(installed.frameworks.size > 0
      ? { CpmFrameworks: [...installed.frameworks].sort((a, b) => a.localeCompare(b)) }
      : {}),
    ...(!installed.direct ? { IsTransitive: true } : {}),
    ...(installed.dependencyOf.size > 0
      ? { DependencyOf: [...installed.dependencyOf].sort((a, b) => a.localeCompare(b)) }
      : {}),
  };
}

export function createHostAPI(context?: vscode.ExtensionContext): HostAPI {
  const scanCache = new ScanCacheStore(context?.workspaceState);
  return {
    async getProjectsAsync(request: CacheControl, signal?: AbortSignal): Promise<Result<GetProjectsResponse>> {
      Logger.info("getProjects: Handling request");
      const settings = getCpmSettings();

      // Discover solution files (.sln / .slnx) in workspace roots (non-recursive).
      // If any exist, restrict project discovery to only the projects they reference.
      const slnFiles = await vscode.workspace.findFiles("*.{sln,slnx}", "**/node_modules/**");
      let solutionProjectPaths: Set<string> | null = null;

      if (slnFiles.length > 0) {
        const allPaths = (
          await Promise.all(slnFiles.map((f) => parseSolutionProjectPathsAsync(f.fsPath)))
        ).flat().filter((p): p is string => p !== null);
        if (allPaths.length > 0) {
          solutionProjectPaths = new Set(allPaths.map((p) => path.normalize(p)));
          Logger.info(`getProjects: Found ${slnFiles.length} solution file(s), ${solutionProjectPaths.size} project(s) referenced`);
        }
      }

      let projectFiles = await vscode.workspace.findFiles(
        "**/*.{csproj,fsproj,vbproj}",
        "**/node_modules/**"
      );
      projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

      if (solutionProjectPaths !== null) {
        projectFiles = projectFiles.filter((f) => solutionProjectPaths!.has(path.normalize(f.fsPath)));
      }

      Logger.info(`getProjects: Found ${projectFiles.length} project files`);

      if (projectFiles.length === 0) {
        return ok({ Projects: [] });
      }

      // The .NET core owns project parsing, CPM resolution and framework evaluation. VS Code
      // keeps discovery: workspace globbing, solution restriction and exclude settings are host
      // concerns, and duplicating them in the core would drift.
      try {
        const projects = await parseProjectsAsync(projectFiles.map((file) => file.fsPath), signal);
        return ok({ Projects: projects });
      } catch (error) {
        Logger.error("getProjects: The .NET core could not parse the workspace", error);
        return fail(formatApiError(error));
      }
    },

    async getPackagesAsync(request: GetPackagesRequest, signal?: AbortSignal): Promise<Result<GetPackagesResponse>> {
      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      StatusBarUtils.show(0, "Loading packages...");

      try {
        if (request.ForceReload) {
          nugetApiFactory.ClearCache();
        }

        if (request.Url === "") {
          const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

          if (!request.Filter) {
            request.Url = sources[0]?.Url ?? "";
            if (!request.Url) return ok({ Packages: [] });
          } else {
            const allPackages = await searchAcrossSourcesAsync(sources, request, signal);
            return ok({ Packages: sortPackages(allPackages, request.Sort) });
          }
        }

        const packages = await fetchPackagesFromUrlAsync(request.Url, request, signal);
        return ok({ Packages: sortPackages(packages.data, request.Sort) });
      } catch (err: unknown) {
        Logger.error(`getPackages: Failed`, err);
        return fail(formatApiError(err));
      } finally {
        StatusBarUtils.hide();
      }
    },

    async getPackageAsync(request: GetPackageRequest, signal?: AbortSignal): Promise<Result<GetPackageResponse>> {
      if (request.Url === "") {
        return fetchPackageFromAnySourceAsync(request, signal);
      }

      try {
        return await fetchPackageFromSourceAsync(request.Url, request, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`getPackage: Exception for ${request.Id}`, err);
        return fail(`Failed to fetch package: ${message}`);
      }
    },

    async getPackageDetailsAsync(request: GetPackageDetailsRequest, signal?: AbortSignal): Promise<Result<GetPackageDetailsResponse>> {
      if (!request.Url) return fail("SourceUrl is empty");
      if (!request.Id) return fail("Package id is empty");
      if (!request.Version) return fail("Package version is empty");

      try {
        const api = await nugetApiFactory.GetSourceApiAsync(request.Url);
        const details = await api.GetPackageDetailsAsync(request.Id, request.Version, signal);
        return ok({ Package: details.data });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`getPackageDetails: Failed for ${request.Id} ${request.Version}`, err);
        return fail(`Failed to fetch package details: ${message}`);
      }
    },

    async getPackageFrameworksAsync(request: GetPackageFrameworksRequest, signal?: AbortSignal): Promise<Result<GetPackageFrameworksResponse>> {
      if (!request.Url) return fail("SourceUrl is empty");
      if (!request.Id) return fail("Package id is empty");
      if (!request.Version) return fail("Package version is empty");

      try {
        const api = await nugetApiFactory.GetSourceApiAsync(request.Url);
        const frameworks = await api.GetPackageFrameworksAsync(request.Id, request.Version, signal);
        return ok({ Groups: frameworks.data.Groups });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error(`getPackageFrameworks: Failed for ${request.Id} ${request.Version}`, err);
        return fail(`Failed to fetch supported frameworks: ${message}`);
      }
    },

    async updateProjectAsync(request: UpdateProjectRequest, signal?: AbortSignal): Promise<Result<UpdateProjectResponse>> {
      return runProjectUpdateAsync(request, signal);
    },

    async getConfigurationAsync(): Promise<Result<GetConfigurationResponse>> {
      Logger.info("getConfiguration: Retrieving configuration");

      const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
      const sourcesWithCreds = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);

      const sources: Source[] = sourcesWithCreds.map((s) => ({
        Name: s.Name,
        Url: s.Url,
      }));

      const vscodeSourcesRaw = getSetting<string[]>("sources", []);
      for (const rawSourceConfig of vscodeSourcesRaw) {
        try {
          const parsed = JSON.parse(rawSourceConfig) as {
            name?: string;
            passwordScriptPath?: string;
          };
          if (parsed.name && parsed.passwordScriptPath) {
            const source = sources.find((s) => s.Name === parsed.name);
            if (source) {
              source.PasswordScriptPath = parsed.passwordScriptPath;
            }
          }
        } catch (e) {
          Logger.warn(`getConfiguration: Failed to parse source config: ${rawSourceConfig}`, e);
        }
      }

      return ok({
        Configuration: {
          SkipRestore: getSetting<boolean>("skipRestore", false),
          EnablePackageVersionInlineInfo: getSetting<boolean>("enablePackageVersionInlineInfo", false),
          Prerelease: getSetting<boolean>("prerelease", false),
          Sources: sources,
          StatusBarLoadingIndicator: getSetting<boolean>("statusBarLoadingIndicator", false),
        },
      });
    },

    async updateConfigurationAsync(request: UpdateConfigurationRequest): Promise<Result<void>> {
      Logger.info("updateConfiguration: Updating configuration");
      const config = getConfiguration();

      const sources = request.Configuration.Sources.map((x) =>
        JSON.stringify({
          name: x.Name,
          url: x.Url,
          ...(x.PasswordScriptPath && { passwordScriptPath: x.PasswordScriptPath }),
        })
      );

      if (getSetting<boolean>("skipRestore", false) !== request.Configuration.SkipRestore) {
        await config.update("skipRestore", request.Configuration.SkipRestore, vscode.ConfigurationTarget.Global);
      }
      if (getSetting<boolean>("enablePackageVersionInlineInfo", false) !== request.Configuration.EnablePackageVersionInlineInfo) {
        await config.update("enablePackageVersionInlineInfo", request.Configuration.EnablePackageVersionInlineInfo, vscode.ConfigurationTarget.Global);
      }
      if (getSetting<boolean>("prerelease", false) !== request.Configuration.Prerelease) {
        await config.update("prerelease", request.Configuration.Prerelease, vscode.ConfigurationTarget.Global);
      }
      const currentSources = getSetting<string[]>("sources", []);
      if (JSON.stringify(currentSources) !== JSON.stringify(sources)) {
        await config.update("sources", sources, vscode.ConfigurationTarget.Global);
      }

      Logger.info("updateConfiguration: Configuration updated successfully");
      return ok(undefined as void);
    },

    openUrlAsync(request: OpenUrlRequest): Promise<Result<void>> {
      Logger.info(`openUrl: Opening ${request.Url}`);
      let protocol = "";
      try {
        protocol = new URL(request.Url).protocol;
      } catch {
        return Promise.resolve(fail(`Invalid URL: ${request.Url}`));
      }
      if (protocol !== "https:" && protocol !== "http:") {
        return Promise.resolve(fail(`Refusing to open unsupported URL scheme: ${protocol}`));
      }
      void vscode.env.openExternal(vscode.Uri.parse(request.Url));
      return Promise.resolve(ok(undefined as void));
    },

    updateStatusBarAsync(request: UpdateStatusBarRequest): Promise<Result<void>> {
      if (request.Percentage === null) {
        StatusBarUtils.hide();
      } else {
        StatusBarUtils.show(request.Percentage, request.Message);
      }
      return Promise.resolve(ok(undefined as void));
    },

    async getOutdatedPackagesAsync(request: GetOutdatedPackagesRequest, signal?: AbortSignal): Promise<Result<GetOutdatedPackagesResponse>> {
      Logger.info("getOutdatedPackages: Checking for outdated packages");
      StatusBarUtils.show(0, "Checking for updates...");
      const scanStarted = Date.now();
      const scanId = request.ScanId;
      const report = createScanReporter(scanId);

      const validationError = await validateOutdatedRequestAsync(request);
      if (validationError) {
        StatusBarUtils.hide();
        return fail(validationError);
      }
      if (request.ForceReload) nugetApiFactory.ClearCache(true);

      try {
        if (scanId) ScanProgress.Begin(scanId, "Resolving package sources…");
        const prepared = await prepareOutdatedScanAsync(request, scanCache, report);
        if (prepared.kind === "empty") return ok({ Packages: [] });
        if (prepared.kind === "cached") {
          StatusBarUtils.hide();
          return ok(prepared.cached);
        }

        const projects = await parseOutdatedProjectsAsync(prepared.projectFiles, report);
        const state = buildInstalledState(projects);
        Logger.info(`getOutdatedPackages: ${state.installedMap.size} unique packages to check`);

        const candidates = await collectOutdatedCandidatesAsync({
          installedMap: state.installedMap,
          sources: prepared.sources,
          request,
          settings: prepared.settings,
          signal,
          report,
        });

        const { outdated, blocked } = await applyOutdatedConstraintsAsync({
          candidates,
          groups: state.groups,
          sources: prepared.sources,
          signal,
          report,
        });

        await saveOutdatedScanAsync(scanCache, prepared.cacheKey, outdated, blocked);
        Logger.info(
          `getOutdatedPackages: Found ${outdated.length} outdated packages, ${blocked.length} held back in ${Date.now() - scanStarted}ms total`
        );

        const response: GetOutdatedPackagesResponse = { Packages: outdated };
        if (blocked.length > 0) response.BlockedPackages = blocked;
        return ok(response);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getOutdatedPackages: Failed", err);
        return fail(`Failed to check for outdated packages: ${message}`);
      } finally {
        if (scanId) ScanProgress.Complete(scanId);
        StatusBarUtils.hide();
      }
    },
    async batchUpdatePackagesAsync(request: BatchUpdateRequest, signal?: AbortSignal): Promise<Result<BatchUpdateResponse>> {
      return runBatchUpdateAsync(request, signal);
    },

    async checkBatchUpdateAsync(
      request: BatchUpdateRequest,
      signal?: AbortSignal
    ): Promise<Result<CheckBatchUpdateResponse>> {
      if (!Array.isArray(request.Updates) || request.Updates.length === 0) {
        return ok({ Conflicts: [] });
      }

      const outsideWorkspace = await findOutsideWorkspaceAsync(
        request.Updates.flatMap((update) => update.ProjectPaths)
      );
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      try {
        const conflicts = await findBatchUpdateConflictsAsync(request, signal);
        Logger.info(
          `checkBatchUpdate: ${conflicts.length} conflict(s) across ${request.Updates.length} update(s)`
        );
        return ok({ Conflicts: conflicts });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("checkBatchUpdate: Failed", err);
        return fail(`Failed to check the update set: ${message}`);
      }
    },

    startBatchUpdateAsync(request: BatchUpdateRequest): Promise<Result<StartJobResponse>> {
      if (!Array.isArray(request.Updates) || request.Updates.length === 0) {
        return Promise.resolve(fail("No packages to update"));
      }
      if (OperationJobs.Batch.HasRunning()) {
        // Two interleaved transactions would let one job's rollback undo
        // another job's writes.
        return Promise.resolve(fail("Another update is already running. Wait for it to finish."));
      }

      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Batch.Start(jobId, (jobSignal, jobReport) => runBatchUpdateAsync(request, jobSignal, jobReport));
      Logger.info(`batchUpdatePackages: Started job ${jobId} for ${request.Updates.length} packages`);
      return Promise.resolve(ok({ JobId: jobId }));
    },

    startProjectUpdateAsync(request: UpdateProjectRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Project.Start(jobId, (jobSignal, jobReport) => runProjectUpdateAsync(request, jobSignal, jobReport));
      Logger.info(`updateProject: Started job ${jobId} for ${request.Type} ${request.PackageId}`);
      return Promise.resolve(ok({ JobId: jobId }));
    },

    startConsolidateAsync(request: ConsolidateRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Consolidate.Start(jobId, (jobSignal, jobReport) => runConsolidateAsync(request, jobSignal, jobReport));
      Logger.info(`consolidatePackages: Started job ${jobId} for ${request.PackageId}`);
      return Promise.resolve(ok({ JobId: jobId }));
    },

    startCleanupAsync(_request: CleanupUnusedRequest): Promise<Result<StartJobResponse>> {
      const jobId = globalThis.crypto.randomUUID();
      OperationJobs.Cleanup.Start(jobId, (jobSignal, jobReport) => runCleanupAsync(jobSignal, jobReport));
      Logger.info(`cleanupUnusedPackages: Started job ${jobId}`);
      return Promise.resolve(ok({ JobId: jobId }));
    },

    getJobAsync(request: JobRequest): Promise<Result<GetJobResponse>> {
      const status = OperationJobs.Get(request.JobId);
      if (!status) return Promise.resolve(fail(`Unknown job: ${request.JobId}`));
      return Promise.resolve(ok(status));
    },

    cancelJobAsync(request: JobRequest): Promise<Result<void>> {
      if (!OperationJobs.Cancel(request.JobId)) {
        return Promise.resolve(fail(`Job is not running: ${request.JobId}`));
      }
      Logger.info(`cancelJob: Cancel requested for job ${request.JobId}`);
      return Promise.resolve(ok(undefined));
    },

    updateBadgeAsync(request: UpdateBadgeRequest): Promise<Result<void>> {
      SetUpdateBadge(request.Count, request.BlockedCount ?? 0);
      return Promise.resolve(ok(undefined));
    },

    async getCleanupReportAsync(
      _request: CleanupUnusedRequest,
      signal?: AbortSignal
    ): Promise<Result<CleanupReport>> {
      try {
        return ok(await buildCleanupReportAsync(signal));
      } catch (err) {
        return fail(`Failed to build cleanup report: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    async cleanupUnusedPackagesAsync(
      _request: CleanupUnusedRequest,
      signal?: AbortSignal
    ): Promise<Result<CleanupUnusedResponse>> {
      return runCleanupAsync(signal);
    },

    async restoreProjectsAsync(request: RestoreProjectsRequest, signal?: AbortSignal): Promise<Result<void>> {
      const outsideWorkspace = await findOutsideWorkspaceAsync(request.ProjectPaths);
      if (outsideWorkspace) {
        return fail(`Project path is outside the workspace: ${outsideWorkspace}`);
      }

      const configSkipRestore = getSetting<boolean>("skipRestore", false);
      if (configSkipRestore) {
        Logger.info("restoreProjects: skipped (skipRestore setting is enabled)");
        return ok(undefined);
      }

      const uniquePaths = [...new Set(request.ProjectPaths)];
      Logger.info(`restoreProjects: Restoring ${uniquePaths.length} project(s)`);
      StatusBarUtils.ShowText("Restoring packages...");
      let failure: RestoreFailure | null;
      try {
        failure = await restoreProjectsInternalAsync(uniquePaths, signal, true);
      } finally {
        StatusBarUtils.hide();
      }
      if (failure) {
        return fail(failure.message);
      }
      return ok(undefined);
    },

    async getInconsistentPackagesAsync(request: GetInconsistentPackagesRequest, _signal?: AbortSignal): Promise<Result<GetInconsistentPackagesResponse>> {
      Logger.info("getInconsistentPackages: Checking for version inconsistencies");

      const validationError = await validateProjectPathsAsync(request.ProjectPaths);
      if (validationError) return fail(validationError);

      try {
        const settings = getCpmSettings();
        const projectFiles = await findScanProjectFilesAsync(request.ProjectPaths, settings.excludeGlobs);
        const { projects, anyCpmEnabled } = await parseProjectsForScanAsync(projectFiles, "getInconsistentPackages");
        const packageMap = buildVersionConsistencyMap(projects);

        const inconsistent = buildInconsistentPackages(packageMap, anyCpmEnabled);
        inconsistent.sort((a, b) => a.Id.localeCompare(b.Id));
        Logger.info(`getInconsistentPackages: Found ${inconsistent.length} inconsistent packages`);
        return ok({ Packages: inconsistent });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getInconsistentPackages: Failed", err);
        return fail(`Failed to check for inconsistent packages: ${message}`);
      }
    },
    async getVulnerablePackagesAsync(request: GetVulnerablePackagesRequest, signal?: AbortSignal): Promise<Result<GetVulnerablePackagesResponse>> {
      Logger.info("getVulnerablePackages: Scanning for vulnerable packages");
      StatusBarUtils.show(0, "Scanning for vulnerabilities...");

      const validationError = await validateProjectPathsAsync(request.ProjectPaths);
      if (validationError) {
        StatusBarUtils.hide();
        return fail(validationError);
      }

      try {
        const workspaceRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const sources = await NuGetConfigResolver.GetSourcesAndDecodePasswordsAsync(workspaceRoots);
        if (request.ForceReload) await clearVulnerabilityCachesAsync(sources);
        if (sources.length === 0) return ok({ Packages: [] });

        const settings = getCpmSettings();
        const projectFiles = await findScanProjectFilesAsync(request.ProjectPaths, settings.excludeGlobs);
        const { projects } = await parseProjectsForScanAsync(projectFiles, "getVulnerablePackages");

        const installedMap = buildVulnerableInstalledMap(projects);
        await addTransitivePackagesAsync(projects, installedMap);

        StatusBarUtils.show(30, "Fetching vulnerability data...");
        const allVulnerabilities = await fetchVulnerabilitiesAsync(sources, signal);

        StatusBarUtils.show(60, "Matching vulnerabilities...");
        const vulnerable = matchVulnerablePackages(installedMap, allVulnerabilities);
        vulnerable.sort((a, b) => b.Severity - a.Severity || a.Id.localeCompare(b.Id));

        Logger.info(`getVulnerablePackages: Found ${vulnerable.length} vulnerable packages`);
        return ok({ Packages: vulnerable });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        Logger.error("getVulnerablePackages: Failed", err);
        return fail(`Failed to scan for vulnerabilities: ${message}`);
      } finally {
        StatusBarUtils.hide();
      }
    },
    async showConfirmationAsync(request: ShowConfirmationRequest): Promise<Result<ShowConfirmationResponse>> {
      const opts: vscode.MessageOptions = { modal: true };
      if (request.Detail !== undefined) opts.detail = request.Detail;
      const answer = await vscode.window.showWarningMessage(
        request.Message,
        opts,
        "Yes"
      );
      return ok({ Confirmed: answer === "Yes" });
    },

    getOperationProgressAsync(request: GetOperationProgressRequest): Promise<Result<GetOperationProgressResponse>> {
      const progress = TaskExecutor.GetProgress(request.OperationId);
      if (progress === null) {
        return Promise.resolve(ok({ Stage: "", Percent: 0, Active: false }));
      }
      return Promise.resolve(ok({ Stage: progress.stage, Percent: progress.percent, Active: true }));
    },

    getOutdatedScanProgressAsync(request: GetOutdatedScanProgressRequest): Promise<Result<GetOutdatedScanProgressResponse>> {
      const progress = ScanProgress.Get(request.ScanId);
      if (progress === null) {
        return Promise.resolve(ok({ Stage: "", Percent: 0, Completed: 0, Total: 0, Active: false }));
      }
      return Promise.resolve(ok({ ...progress, Active: true }));
    },

    async consolidatePackagesAsync(request: ConsolidateRequest, signal?: AbortSignal): Promise<Result<void>> {
      return runConsolidateAsync(request, signal);
    },

    async getDependencyIssuesAsync(
      request: GetDependencyIssuesRequest,
      _signal?: AbortSignal
    ): Promise<Result<GetDependencyIssuesResponse>> {
      try {
        const projectPaths = request.ProjectPaths?.length
          ? request.ProjectPaths
          : await findProjectFilesForDiagnosticsAsync();

        const issues: DependencyIssue[] = [];
        const skippedPaths: string[] = [];
        let projectsScanned = 0;
        for (const projectPath of projectPaths) {
          const analysis = await coreProcess.CallAsync<{
            Issues: DependencyIssue[];
            Skipped: boolean;
            Reason?: string;
          }>("analyzeProjectDependencies", { projectPath });
          if (analysis.Skipped) {
            skippedPaths.push(projectPath);
            Logger.debug(`getDependencyIssues: skipped ${projectPath} (${analysis.Reason ?? "unknown"})`);
            continue;
          }
          projectsScanned++;
          issues.push(...analysis.Issues);
        }

        Logger.info(
          `getDependencyIssues: ${issues.length} issue(s) across ${projectsScanned} restored project(s), ${skippedPaths.length} skipped`
        );
        return ok({
          Issues: issues,
          ProjectsScanned: projectsScanned,
          ProjectsSkipped: skippedPaths.length,
          SkippedProjectPaths: skippedPaths,
        });
      } catch (err) {
        Logger.error("getDependencyIssues: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async fixRestoreConflictAsync(
      request: FixRestoreConflictRequest
    ): Promise<Result<FixRestoreConflictResponse>> {
      if (!isValidPackageId(request.PackageId)) {
        return fail(`"${request.PackageId}" is not a valid package id.`);
      }
      if (!isValidNuGetVersion(request.Version)) {
        return fail(`"${request.Version}" is not a valid version.`);
      }

      try {
        let target = request.Target;
        if (!target) {
          const cpmMap = await CpmReader.GetFrameworkPackageMapAsync(request.ProjectPath);
          target = cpmMap && CpmReader.HasPackage(cpmMap, request.PackageId) ? "cpm" : "project";
        }

        if (target === "cpm") {
          await CpmWriter.UpdatePackageVersionAsync(
            request.ProjectPath,
            request.PackageId,
            request.Version,
            undefined,
            undefined,
            getWorkspaceRoots()
          );
        } else {
          await TaskExecutor.ExecuteCommandAsync(
            "dotnet",
            [
              "add",
              request.ProjectPath.replace(/\\/g, "/"),
              "package",
              request.PackageId,
              "--version",
              request.Version,
              "--no-restore",
            ],
            `fix-conflict-${request.PackageId}`,
            undefined,
            undefined,
            undefined,
            CreateDotnetOptions(request.ProjectPath)
          );
        }

        // The fix is only useful if the graph restores; keep the restore
        // authoritative and report its failure instead of claiming success.
        const failure = await restoreProjectsInternalAsync([request.ProjectPath], undefined, false);
        toolchainHealthCache = null;
        Logger.info(
          `fixRestoreConflict: ${request.PackageId} -> ${request.Version} (${target}) restored=${!failure}`
        );
        return ok({
          Applied: true,
          ...(failure ? { RestoreError: failure.message } : {}),
        });
      } catch (err) {
        Logger.error("fixRestoreConflict: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async updateCentralVersionsAsync(
      request: UpdateCentralVersionsRequest
    ): Promise<Result<UpdateCentralVersionsResponse>> {
      try {
        const projectPaths = request.ProjectPaths?.length
          ? request.ProjectPaths
          : await findProjectFilesForDiagnosticsAsync();
        const projectPath = projectPaths.find((candidate) => existsSync(candidate));
        if (!projectPath) {
          return fail("No project found to locate Directory.Packages.props.");
        }

        const propsFile = findDirectoryPackagesPropsPath(projectPath);
        if (!propsFile) {
          return fail("Central Package Management is not enabled in this workspace.");
        }

        const cpmMap = await CpmReader.GetFrameworkPackageMapAsync(projectPath);
        const defined = cpmMap ? CpmReader.PackageIds(cpmMap) : new Set<string>();
        const plan = PlanCentralUpdates(request.Updates, defined);
        if (plan.Changes.length === 0 && plan.Conditional.length === 0) {
          return ok({ Applied: [], Skipped: plan.Skipped, PropsFile: propsFile });
        }

        const workspaceRoots = getWorkspaceRoots();

        // Snapshot before writing: the batch rolls back project files, but this props write is
        // outside that snapshot, so a failed restore must undo it — including any property file
        // the write edits in place of the props file. The unconditional changes may resolve to a
        // property definition elsewhere; the conditional ones stay literal.
        const preflightChanges: CpmVersionChange[] = [
          ...plan.Changes,
          ...plan.Conditional.map((entry) => ({
            packageId: entry.PackageId,
            version: entry.Version,
            condition: entry.Condition,
            scope: "group" as const,
          })),
        ];
        let targets: string[] = [propsFile];
        try {
          const resolved = await CpmWriter.ResolveWriteTargetsAsync(
            propsFile,
            preflightChanges,
            projectPaths,
            workspaceRoots
          );
          targets = [...new Set([propsFile, ...resolved])];
        } catch {
          targets = [propsFile];
        }

        const snapshots = new Map<string, string>();
        for (const file of targets) {
          snapshots.set(file, await fs.readFile(file, "utf8"));
        }

        await WriteCentralVersionsAsync(propsFile, plan, projectPaths, workspaceRoots);

        const failure = await restoreProjectsInternalAsync([projectPath], undefined, false);
        if (failure) {
          // Undo every snapshot so a failed restore cannot leave the props file — or a property
          // file it wrote — in a half-applied state.
          for (const [file, content] of snapshots) {
            await fs.writeFile(file, content, "utf8");
          }
          Logger.warn(`updateCentralVersions: restore failed, reverted ${targets.join(", ")}`);
        }
        toolchainHealthCache = null;
        Logger.info(
          `updateCentralVersions: raised ${plan.Applied.length} version(s) in ${propsFile}, restored=${!failure}`
        );
        return ok({
          Applied: plan.Applied,
          Skipped: plan.Skipped,
          PropsFile: propsFile,
          ...(failure ? { RestoreError: failure.message } : {}),
        });
      } catch (err) {
        Logger.error("updateCentralVersions: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async getToolchainHealthAsync(
      request: GetToolchainHealthRequest,
      _signal?: AbortSignal
    ): Promise<Result<GetToolchainHealthResponse>> {
      try {
        const health = await readToolchainHealthAsync(request.ProjectPaths ?? [], request.ForceRefresh === true);
        return ok({ Health: health });
      } catch (err) {
        Logger.error("getToolchainHealth: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async setWorkspaceSdkAsync(
      request: SetWorkspaceSdkRequest
    ): Promise<Result<SetWorkspaceSdkResponse>> {
      const version = request.Version?.trim() ?? "";
      if (!IsValidGlobalJsonSdkVersion(version)) {
        return fail(`"${version}" is not a valid .NET SDK version.`);
      }

      try {
        const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
        const projectPaths = request.ProjectPaths?.length
          ? request.ProjectPaths
          : await findProjectFilesForDiagnosticsAsync();
        const projectPath = projectPaths.find((candidate) => existsSync(candidate));
        const startDirectory = projectPath ? path.dirname(projectPath) : workspaceRoot;

        const health = await readToolchainHealthAsync([], false);
        if (!health.InstalledSdks.some((sdk) => sdk.Version === version)) {
          return fail(`.NET SDK ${version} is not installed. Use "Install SDK" first.`);
        }

        const dotnetCommand = projectPath
          ? ResolveDotnetContext(projectPath).Command
          : ResolveDotnetCommand(workspaceRoot);
        const result = await UpdateGlobalJsonSdkVersionAsync({
          StartDirectory: startDirectory,
          Version: version,
          Command: dotnetCommand,
        });
        toolchainHealthCache = null;
        Logger.info(
          `setWorkspaceSdk: ${version} -> ${result.GlobalJsonPath} (created=${result.Created}, source=${result.Source})`
        );
        return ok({ GlobalJsonPath: result.GlobalJsonPath, Version: version, Notes: result.Notes });
      } catch (err) {
        Logger.error("setWorkspaceSdk: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },

    async installSdkAsync(request: InstallSdkRequest): Promise<Result<InstallSdkResponse>> {
      const version = request.Version?.trim() ?? "";
      if (!IsValidSdkVersion(version)) {
        return fail(`"${version}" is not a valid .NET SDK version.`);
      }
      if (!vscode.workspace.isTrusted) {
        return fail("Installing a .NET SDK requires a trusted workspace.");
      }
      const storage = context?.globalStorageUri?.fsPath;
      if (!storage) {
        return fail("Extension storage is unavailable, so the SDK cannot be installed.");
      }

      StatusBarUtils.ShowText(`Installing .NET SDK ${version}...`);
      try {
        const result = await InstallSdkAsync({
          Version: version,
          InstallRoot: GetSdkInstallRoot(),
          StagingDirectory: path.join(storage, "dotnet-install"),
        });

        // Pinning happens in global.json, the file dotnet itself reads.
        const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
        const projectPaths = await findProjectFilesForDiagnosticsAsync();
        const projectPath = projectPaths.find((candidate) => existsSync(candidate));
        await WriteGlobalJsonSdkVersionAsync({
          StartDirectory: projectPath ? path.dirname(projectPath) : workspaceRoot,
          Version: version,
        });
        toolchainHealthCache = null;
        Logger.info(`installSdk: ${version} -> ${result.InstallRoot}`);
        return ok(result);
      } catch (err) {
        Logger.error("installSdk: failed", err);
        return fail(DescribeSdkInstallFailure(err));
      } finally {
        StatusBarUtils.hide();
      }
    },

    async runWorkloadCommandAsync(
      request: RunWorkloadCommandRequest
    ): Promise<Result<RunWorkloadCommandResponse>> {
      if (!vscode.workspace.isTrusted) {
        return fail("Running .NET workload commands requires a trusted workspace.");
      }

      try {
        const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
        const projectPaths = request.ProjectPaths?.length
          ? request.ProjectPaths
          : await findProjectFilesForDiagnosticsAsync();
        const context = projectPaths[0]
          ? ResolveDotnetContext(projectPaths[0])
          : {
            WorkingDirectory: ResolveWorkingDirectory(workspaceRoot),
            Command: ResolveDotnetCommand(workspaceRoot),
          };

        StatusBarUtils.ShowText(`Running dotnet workload ${request.Action}...`);
        const result = await RunWorkloadCommandAsync(request.Action, {
          Command: context.Command,
          WorkingDirectory: context.WorkingDirectory,
        });
        // The manifests (or the SDK selection) may have changed.
        toolchainHealthCache = null;
        Logger.info(
          `runWorkloadCommand: ${request.Action} exit=${result.ExitCode} elevation=${result.NeedsElevation}`
        );
        return ok(result);
      } catch (err) {
        Logger.error("runWorkloadCommand: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      } finally {
        StatusBarUtils.hide();
      }
    },

    async runToolchainDiagnosticsAsync(
      request: RunToolchainDiagnosticsRequest
    ): Promise<Result<RunToolchainDiagnosticsResponse>> {
      try {
        const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
        const projectPaths = request.ProjectPaths?.length
          ? request.ProjectPaths
          : await findProjectFilesForDiagnosticsAsync();
        const extensionVersion: string | undefined = vscode.extensions
          .getExtension("i-synergy.nugetpackagemanager")?.packageJSON?.version;
        const report = await BuildToolchainDiagnosticsAsync({
          WorkspaceRoot: workspaceRoot,
          ProjectPaths: projectPaths,
          ...(extensionVersion ? { ExtensionVersion: extensionVersion } : {}),
        });
        Logger.info(`Toolchain diagnostics requested\n${report}`);
        return ok({ Report: report });
      } catch (err) {
        Logger.error("runToolchainDiagnostics: failed", err);
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  };
}

// ============================================================
// Toolchain health cache
// ============================================================

let toolchainHealthCache: { Key: string; Health: ToolchainHealth } | null = null;

async function readToolchainHealthAsync(
  requestedProjects: string[],
  forceRefresh: boolean
): Promise<ToolchainHealth> {
  const workspaceRoot = getWorkspaceRoots()[0] ?? process.cwd();
  const projectPaths = requestedProjects.length > 0
    ? requestedProjects
    : await findProjectFilesForDiagnosticsAsync();
  const key = [workspaceRoot, projectPaths[0] ?? ""].join("\0");

  if (!forceRefresh && toolchainHealthCache?.Key === key) {
    return toolchainHealthCache.Health;
  }

  const health = await ProbeToolchainAsync({
    WorkspaceRoot: workspaceRoot,
    ProjectPaths: projectPaths,
    ForceRefresh: forceRefresh,
  });
  toolchainHealthCache = { Key: key, Health: health };
  if (health.Issues.length > 0) {
    Logger.warn(`Toolchain health: ${health.Issues.map((issue) => issue.Summary).join(" | ")}`);
  }
  return health;
}

/** `CentralPackageTransitivePinningEnabled` from the project's CPM props file. */
function isCentralTransitivePinningEnabled(projectPath: string): boolean {
  const propsFile = findDirectoryPackagesPropsPath(projectPath);
  if (!propsFile) return false;
  try {
    return /<CentralPackageTransitivePinningEnabled>\s*true\s*</i.test(
      readFileSync(propsFile, "utf8")
    );
  } catch {
    return false;
  }
}

/** Nearest `Directory.Packages.props` for a project. */
function findDirectoryPackagesPropsPath(projectPath: string): string | null {
  let directory = path.dirname(projectPath);
  for (let depth = 0; depth < 32; depth++) {
    const candidate = path.join(directory, "Directory.Packages.props");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}

/**
 * Project discovery for tooling that runs without a selection.
 *
 * Mirrors `getProjectsAsync`: when a solution exists only its projects are
 * managed, and the configured exclude globs (which also drop hidden folders such
 * as `.ai/tmp`) always apply. Without this, a vendored or cached project tree in
 * the workspace would be analysed — and restored — by mistake.
 */
async function findProjectFilesForDiagnosticsAsync(): Promise<string[]> {
  const settings = getCpmSettings();
  const slnFiles = await vscode.workspace.findFiles("*.{sln,slnx}", "**/node_modules/**");

  let solutionProjectPaths: Set<string> | null = null;
  if (slnFiles.length > 0) {
    const allPaths = (
      await Promise.all(slnFiles.map((file) => parseSolutionProjectPathsAsync(file.fsPath)))
    ).flat().filter((candidate): candidate is string => candidate !== null);
    if (allPaths.length > 0) {
      solutionProjectPaths = new Set(allPaths.map((candidate) => path.normalize(candidate)));
    }
  }

  let files = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  files = applyExcludeGlobs(files, settings.excludeGlobs);
  files = ScopeProjectFiles(files, solutionProjectPaths);
  return files.map((file) => file.fsPath);
}

// ============================================================
// Shared Helpers
// ============================================================

type RestoreFailure = {
  projectPaths: string[];
  conflicts: RestoreConflictInfo[];
  message: string;
  /** First classified cause, so the UI can explain the failure. */
  failure?: DotnetFailure;
};

type RestoreProgress = {
  projectPath: string;
  index: number;
  total: number;
  stage: string;
  percent: number;
};


type FileSnapshot = {
  path: string;
  content: string | null;
};

async function snapshotFilesAsync(paths: string[]): Promise<Map<string, FileSnapshot>> {
  const snapshots = new Map<string, FileSnapshot>();
  for (const filePath of new Set(paths)) {
    try {
      snapshots.set(filePath, { path: filePath, content: await fs.readFile(filePath, "utf8") });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      snapshots.set(filePath, { path: filePath, content: null });
    }
  }
  return snapshots;
}

async function rollbackFilesAsync(
  snapshots: Map<string, FileSnapshot> | undefined
): Promise<string | undefined> {
  if (!snapshots) return undefined;
  const errors: string[] = [];
  for (const snapshot of snapshots.values()) {
    try {
      if (snapshot.content === null) {
        await fs.rm(snapshot.path, { force: true });
      } else {
        await fs.writeFile(snapshot.path, snapshot.content, "utf8");
      }
    } catch (err) {
      errors.push(`${snapshot.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

async function restoreProjectsInternalAsync(
  projectPaths: string[],
  signal: AbortSignal | undefined,
  allowConflictResolution: boolean,
  onProgress?: (progress: RestoreProgress) => void
): Promise<RestoreFailure | null> {
  const failedPaths: string[] = [];
  const conflicts: RestoreConflictInfo[] = [];
  const summaries: string[] = [];
  const failures: DotnetFailure[] = [];
  const uniquePaths = [...new Set(projectPaths)];

  for (const [index, projectPath] of uniquePaths.entries()) {
    if (signal?.aborted) break;
    const reportProgress = (progress: { stage: string; percent: number }): void => {
      onProgress?.({
        projectPath,
        index,
        total: uniquePaths.length,
        stage: progress.stage,
        percent: progress.percent,
      });
    };
    try {
      await restoreOneProjectAsync(projectPath, signal, allowConflictResolution, reportProgress);
    } catch (err) {
      await recordRestoreFailureAsync(err, projectPath, failedPaths, conflicts, summaries, failures);
    }
  }

  if (failedPaths.length === 0) return null;

  const details = conflicts.length > 0
    ? FormatRestoreConflictInfo(conflicts)
    : [...new Set(summaries)].slice(0, 3).join(" | ");
  const detailsSuffix = details ? `: ${details}` : ".";
  const firstFailure = failures[0];
  return {
    projectPaths: failedPaths,
    conflicts,
    message: `Restore failed for ${failedPaths.length} project(s)${detailsSuffix}`,
    ...(firstFailure ? { failure: firstFailure } : {}),
  };
}

async function restoreOneProjectAsync(
  projectPath: string,
  signal: AbortSignal | undefined,
  allowConflictResolution: boolean,
  reportProgress: (progress: { stage: string; percent: number }) => void
): Promise<void> {
  if (allowConflictResolution) {
    await restoreWithConflictResolutionAsync(projectPath, 0, signal, reportProgress);
    return;
  }
  await TaskExecutor.ExecuteCommandAsync(
    "dotnet",
    ["restore", projectPath.replace(/\\/g, "/")],
    `rollback-restore-${projectPath}`,
    signal,
    undefined,
    reportProgress,
    CreateDotnetOptions(projectPath)
  );
}

async function recordRestoreFailureAsync(
  err: unknown,
  projectPath: string,
  failedPaths: string[],
  conflicts: RestoreConflictInfo[],
  summaries: string[],
  failures: DotnetFailure[]
): Promise<void> {
  Logger.error(`restoreProjectsInternal: Failed to restore ${projectPath}`, err);
  failedPaths.push(projectPath);
  if (err instanceof DotnetError) {
    const failure = err.failure
      ?? await ClassifyDotnetFailureAsync(err.output, { ProjectPath: projectPath });
    conflicts.push(...(failure.Conflicts ?? []));
    failures.push(failure);
    // A classified cause is more useful than the raw error block; the detail
    // stays available through the diagnostics panel.
    summaries.push(failure.Summary);
    return;
  }
  summaries.push(err instanceof Error ? err.message : String(err));
}

/** One actionable sentence from the structured conflicts. */
function FormatRestoreConflictInfo(conflicts: RestoreConflictInfo[]): string {
  const entries = conflicts.map((conflict) => {
    const head = conflict.PackageId ? `${conflict.Code} ${conflict.PackageId}` : conflict.Code;
    const chains = conflict.Chains.join("; ");
    return chains ? `${head} — ${chains}` : `${head} — ${conflict.Message}`;
  });
  return [...new Set(entries)].join(" | ");
}

/**
 * Removes a PackageVersion entry from every Directory.Packages.props file whose
 * projects no longer reference the package. Called after an uninstall so CPM
 * does not accumulate stale global references.
 */
async function buildCleanupReportAsync(signal?: AbortSignal): Promise<CleanupReport> {
  const settings = getCpmSettings();
  const projectFiles = applyExcludeGlobs(
    await vscode.workspace.findFiles("**/*.{csproj,fsproj,vbproj}", "**/node_modules/**"),
    settings.excludeGlobs
  );
  const used = await collectUsedPackagesAsync(projectFiles, signal);

  const propsFiles = applyExcludeGlobs(
    await vscode.workspace.findFiles(
      "**/Directory.Packages.props",
      "**/{bin,obj,node_modules,.git}/**"
    ),
    settings.excludeGlobs
  );
  const { defined, propsReports } = await collectDefinedPackagesAsync(propsFiles, used);

  return {
    PropsFiles: propsReports,
    Used: sortedValues(used),
    Missing: collectMissing(used, defined),
    Unused: collectUnused(defined, used),
  };
}

async function collectUsedPackagesAsync(
  projectFiles: Array<{ fsPath: string }>,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  const projects = await parseProjectsAsync(projectFiles.map((file) => file.fsPath), signal);

  // Do not produce a report that could delete a used package because one project could not be
  // read: the core skipping a project is a gap, so refuse to answer.
  if (projects.length !== projectFiles.length) {
    throw new Error(
      `Failed to scan ${projectFiles.length - projects.length} of ${projectFiles.length} project(s)`
    );
  }

  for (const project of projects) {
    for (const pkg of project.Packages) {
      used.set(pkg.Id.toLowerCase(), pkg.Id);
    }
  }

  return used;
}

async function collectDefinedPackagesAsync(
  propsFiles: Array<{ fsPath: string }>,
  used: Map<string, string>
): Promise<{ defined: Map<string, string>; propsReports: CleanupReport["PropsFiles"] }> {
  const defined = new Map<string, string>();
  const propsReports: CleanupReport["PropsFiles"] = [];

  for (const file of propsFiles) {
    const map = await CpmReader.ParseCpmFileAsync(file.fsPath);
    const definedHere = collectDefinedInFile(map);
    for (const [key, id] of definedHere) defined.set(key, id);

    propsReports.push({
      Path: file.fsPath,
      Defined: sortedValues(definedHere),
      Unused: collectUnused(definedHere, used),
    });
  }

  return { defined, propsReports };
}

function collectDefinedInFile(map: CpmPackageMap): Map<string, string> {
  const definedHere = new Map<string, string>();
  for (const id of map.unconditional.keys()) definedHere.set(id.toLowerCase(), id);
  for (const entry of map.conditional) {
    for (const id of entry.versions.keys()) definedHere.set(id.toLowerCase(), id);
  }
  return definedHere;
}

function sortedValues(map: Map<string, string>): string[] {
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

function collectUnused(defined: Map<string, string>, used: Map<string, string>): string[] {
  return [...defined.entries()]
    .filter(([key]) => !used.has(key))
    .map(([, id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

function collectMissing(used: Map<string, string>, defined: Map<string, string>): string[] {
  return [...used.entries()]
    .filter(([key]) => !defined.has(key))
    .map(([, id]) => id)
    .sort((a, b) => a.localeCompare(b));
}

async function cleanupUnusedCpmPackageAsync(packageId: string, signal?: AbortSignal): Promise<void> {
  const settings = getCpmSettings();
  let projectFiles = await vscode.workspace.findFiles(
    "**/*.{csproj,fsproj,vbproj}",
    "**/node_modules/**"
  );
  projectFiles = applyExcludeGlobs(projectFiles, settings.excludeGlobs);

  const cpmFiles = new Set<string>();
  const referencedCpmFiles = new Set<string>();

  // Parse once, up front: the loop below needs each project's package ids and must stay
  // conservative about projects the core could not read.
  const parsedProjects = await parseProjectsAsync(projectFiles.map((file) => file.fsPath), signal);
  const packagesByPath = new Map(
    parsedProjects.map((project) => [path.normalize(project.Path), project.Packages] as const)
  );

  for (const file of projectFiles) {
    if (signal?.aborted) return;
    const cpmFile = await CpmReader.FindCpmFilePathAsync(file.fsPath);
    if (!cpmFile) continue;
    cpmFiles.add(cpmFile);

    const packages = packagesByPath.get(path.normalize(file.fsPath));
    if (!packages) {
      // Be conservative: if a project cannot be parsed, never delete its CPM entry.
      Logger.warn(`cleanupUnusedCpmPackage: Could not parse ${file.fsPath}`);
      referencedCpmFiles.add(cpmFile);
      continue;
    }

    if (packages.some((pkg) => pkg.Id.toLowerCase() === packageId.toLowerCase())) {
      referencedCpmFiles.add(cpmFile);
    }
  }

  for (const cpmFile of cpmFiles) {
    if (referencedCpmFiles.has(cpmFile)) continue;
    try {
      await CpmWriter.RemovePackageVersionAsync(cpmFile, packageId);
    } catch (err) {
      Logger.error(`cleanupUnusedCpmPackage: Failed to clean ${cpmFile}`, err);
      throw err;
    }
  }
}

async function restoreWithConflictResolutionAsync(
  projectPath: string,
  attempt = 0,
  signal?: AbortSignal,
  onProgress?: (progress: { stage: string; percent: number }) => void
): Promise<void> {
  try {
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      ["restore", projectPath.replace(/\\/g, "/")],
      `restore-${projectPath}`,
      signal,
      undefined,
      onProgress,
      CreateDotnetOptions(projectPath)
    );
  } catch (err) {
    await resolveRestoreConflictAsync(err, projectPath, attempt, signal);
  }
}

async function resolveRestoreConflictAsync(
  err: unknown,
  projectPath: string,
  attempt: number,
  signal?: AbortSignal
): Promise<void> {
  const MAX_ATTEMPTS = 2;
  if (!(err instanceof DotnetError) || attempt >= MAX_ATTEMPTS) throw err;

  // Only a package downgrade has an unambiguous automatic remedy (reference the
  // higher version). NU1107 conflicts between an exact pin and a lower bound
  // have no single correct answer, so they are reported instead of rewritten.
  const failure = err.failure
    ?? await ClassifyDotnetFailureAsync(err.output, { ProjectPath: projectPath });
  const conflicts = (failure.Conflicts ?? [])
    .filter((conflict) => conflict.Code === "NU1605" || conflict.Code === "NU1109")
    .filter((conflict) => conflict.PackageId && conflict.SuggestedVersion);
  if (conflicts.length === 0) throw err;

  Logger.info(`restoreWithConflictResolution: Detected ${conflicts.length} NU1605 conflict(s) in ${projectPath}, applying fixes`);
  const fixedAny = await applyConflictFixesAsync(conflicts, projectPath);
  if (!fixedAny) throw err;

  await restoreWithConflictResolutionAsync(projectPath, attempt + 1, signal);
}

async function applyConflictFixesAsync(
  conflicts: RestoreConflictInfo[],
  projectPath: string
): Promise<boolean> {
  const cpmMap = await CpmReader.GetFrameworkPackageMapAsync(projectPath);
  let fixedAny = false;

  for (const conflict of conflicts) {
    const packageId = conflict.PackageId;
    const requiredVersion = conflict.SuggestedVersion!;
    if (cpmMap && CpmReader.HasPackage(cpmMap, packageId)) {
      Logger.info(`restoreWithConflictResolution: Updating CPM ${packageId} to ${requiredVersion}`);
      await CpmWriter.UpdatePackageVersionAsync(
        projectPath,
        packageId,
        requiredVersion,
        undefined,
        undefined,
        getWorkspaceRoots()
      );
      fixedAny = true;
      continue;
    }

    const project = await parseProjectAsync(projectPath);
    if (!project.Packages.some((p) => p.Id === packageId)) continue;

    Logger.info(`restoreWithConflictResolution: Updating direct reference ${packageId} to ${requiredVersion} in ${projectPath}`);
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      ["add", projectPath.replace(/\\/g, "/"), "package", packageId, "--version", requiredVersion, "--no-restore"],
      `fix-conflict-${packageId}`,
      undefined,
      undefined,
      undefined,
      CreateDotnetOptions(projectPath)
    );
    fixedAny = true;
  }

  return fixedAny;
}

async function executeRemovePackageAsync(packageId: string, projectPath: string, operationId?: string, signal?: AbortSignal): Promise<void> {
  StatusBarUtils.ShowText(`Removing package ${packageId}...`);
  const args = ["remove", projectPath.replace(/\\/g, "/"), "package", packageId];
  try {
    await TaskExecutor.ExecuteCommandAsync(
      "dotnet",
      args,
      operationId ?? `remove-${packageId}`,
      signal,
      undefined,
      undefined,
      CreateDotnetOptions(projectPath)
    );
  } catch (error) {
    // The dependency analysis reads project.assets.json, which can still describe a reference
    // that was already removed from the .csproj (or was declared in an imported file). The
    // goal of an uninstall is for the package not to be a direct reference, so this is a
    // successful no-op rather than a rollback-worthy failure.
    if (isAlreadyRemovedError(error, packageId)) {
      Logger.info(
        `updateProject: ${packageId} is already absent from ${projectPath}; treating the uninstall as applied`
      );
      return;
    }
    throw error;
  }
}

function isAlreadyRemovedError(error: unknown, packageId: string): boolean {
  if (!(error instanceof DotnetError)) {
    return false;
  }

  return /does not contain any PackageReference/i.test(error.output)
    && error.output.toLowerCase().includes(packageId.toLowerCase());
}

async function executeAddPackageAsync(
  packageId: string,
  projectPath: string,
  version?: string,
  skipRestore = false,
  sourceUrl?: string,
  operationId?: string,
  signal?: AbortSignal
): Promise<void> {
  StatusBarUtils.ShowText(`Installing package ${packageId} ${version || "latest"}...`);
  const args = ["add", projectPath.replace(/\\/g, "/"), "package", packageId];

  if (version) {
    args.push("--version", version);
  }
  if (skipRestore) {
    args.push("--no-restore");
  }
  if (sourceUrl) {
    args.push("-s", sourceUrl);
  }

  await TaskExecutor.ExecuteCommandAsync(
    "dotnet",
    args,
    operationId ?? `add-${packageId}`,
    signal,
    undefined,
    undefined,
    CreateDotnetOptions(projectPath)
  );
}

async function getLatestVersionAsync(
  packageId: string,
  prerelease: boolean,
  sources: Array<{ Name: string; Url: string; Patterns?: string[] }>,
  signal?: AbortSignal
): Promise<{ version: string; versions: string[]; sourceUrl: string; sourceName: string } | null> {
  let best: { version: string; versions: string[]; sourceUrl: string; sourceName: string } | null = null;

  const mappedSources = sources.filter((source) => (source.Patterns?.length ?? 0) > 0);
  const candidates = mappedSources.length > 0
    ? sources.filter((source) =>
        source.Patterns?.some((pattern) => matchesPackagePattern(pattern, packageId))
      )
    : sources;

  const promises = candidates.map(async (source) => {
    try {
      const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
      const result = await api.GetPackagesAsync(packageId, prerelease, 0, 1, signal);
      const pkg = result.data.find((p) => p.Name.toLowerCase() === packageId.toLowerCase());
      if (pkg) {
        const versions = [...new Set([
          ...(pkg.Versions ?? []).map((v) => v.Version),
          ...(pkg.Version ? [pkg.Version] : []),
        ])].filter((version) => prerelease || !version.includes("-"));
        const sorted = [...versions].sort(compareVersions);
        return {
          version: sorted[sorted.length - 1] ?? pkg.Version,
          versions: sorted,
          sourceUrl: source.Url,
          sourceName: source.Name,
          // The search payload already carries these; keep them instead of dropping them and
          // re-fetching on click.
          totalDownloads: pkg.TotalDownloads,
          verified: pkg.Verified,
        };
      }
    } catch {
      // Ignore feed errors
    }
    return null;
  });

  const results = await Promise.allSettled(promises);

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      if (!best || compareVersions(result.value.version, best.version) > 0) {
        best = result.value;
      }
    }
  }

  return best;
}

/** Major version of a NuGet version string (empty for non-numeric versions). */
function getVersionMajor(version: string): number | null {
  const release = version.split("+")[0]!.split("-")[0]!;
  const match = /^(\d+)\./.exec(release);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

/** `net10.0-windows` → 10; `netstandard2.0` and unparseable TFMs → null. */
function getTfmMajorVersion(tfm: string): number | null {
  const match = /^net(\d+)\.\d+/i.exec(tfm.trim());
  return match ? Number.parseInt(match[1]!, 10) : null;
}

// ============================================================
// Update-suggestion constraints
// ============================================================

type InstalledPackageEntry = {
  version: string;
  condition: string;
  framework: string;
  conditionLabel: string;
  matched: boolean;
  projects: Array<{ Name: string; Path: string; Version: string }>;
};

type InstalledPackageGroup = {
  tfms: Set<string>;
  projectPaths: Set<string>;
  direct: Map<string, { id: string; versions: Set<string> }>;
};

type OutdatedCandidate = {
  packageId: string;
  installed: InstalledPackageEntry;
  latest: {
    version: string;
    versions: string[];
    sourceUrl: string;
    sourceName: string;
    /** Absent on candidates restored from a persisted scan (older shape). */
    totalDownloads?: number | null;
    verified?: boolean | null;
  };
  available: string[];
};

type PackageConstraint = {
  PackageId: string;
  InstalledVersion: string;
  Range: string;
};

type ProjectDependencyGraph = {
  /** Installed version per package id (lowercased), from project.assets.json. */
  packageVersions: Map<string, string>;
  /** Parent -> child edges, both lowercased. */
  parentsByChild: Map<string, Set<string>>;
  /** Target frameworks restored into this assets file, e.g. `net11.0`. */
  tfms: Set<string>;
};

async function loadProjectDependencyGraphAsync(projectPath: string): Promise<ProjectDependencyGraph | null> {
  const assetsPath = path.join(path.dirname(projectPath), "obj", "project.assets.json");
  try {
    const assets = JSON.parse(await fs.readFile(assetsPath, "utf8")) as {
      libraries?: Record<string, { type?: string }>;
      targets?: Record<string, Record<string, { dependencies?: Record<string, string> }>>;
    };

    const packageVersions = new Map<string, string>();
    for (const [libraryKey, library] of Object.entries(assets.libraries ?? {})) {
      if (library.type !== "package") continue;
      const slash = libraryKey.lastIndexOf("/");
      if (slash <= 0) continue;
      packageVersions.set(libraryKey.slice(0, slash).toLowerCase(), libraryKey.slice(slash + 1));
    }

    const parentsByChild = new Map<string, Set<string>>();
    const tfms = new Set<string>();
    for (const [targetKey, target] of Object.entries(assets.targets ?? {})) {
      tfms.add(targetKey);
      for (const [parentKey, metadata] of Object.entries(target)) {
        const slash = parentKey.lastIndexOf("/");
        if (slash <= 0) continue;
        const parentId = parentKey.slice(0, slash).toLowerCase();
        for (const childId of Object.keys(metadata.dependencies ?? {})) {
          const child = childId.toLowerCase();
          const parents = parentsByChild.get(child) ?? new Set<string>();
          parents.add(parentId);
          parentsByChild.set(child, parents);
        }
      }
    }

    return { packageVersions, parentsByChild, tfms };
  } catch (err) {
    Logger.debug(`getOutdatedPackages: no dependency graph for ${projectPath}`, err);
    return null;
  }
}

/**
 * Picks the dependency group that applies to one of the given target
 * frameworks. Returns null when no group matches, which callers must treat as
 * "no constraint" rather than guessing with another framework's ranges.
 */
function selectDependencyGroup(
  frameworks: Record<string, PackageDependency[]>,
  tfms: string[]
): PackageDependency[] | null {
  const keys = Object.keys(frameworks);
  if (keys.length === 0) return null;

  for (const tfm of tfms) {
    const exact = keys.find((key) => key.toLowerCase() === tfm.toLowerCase());
    if (exact) return frameworks[exact] ?? null;
  }

  for (const tfm of tfms) {
    const major = getTfmMajorVersion(tfm);
    if (major === null) continue;
    const sameMajor = keys.find(
      (key) => key.toLowerCase().startsWith("net") && getTfmMajorVersion(key) === major
    );
    if (sameMajor) return frameworks[sameMajor] ?? null;
  }

  return null;
}

/** Resolves the declared dependency ranges of one exact package version. */
async function fetchDependencyFrameworksAsync(
  packageId: string,
  version: string,
  sources: Array<{ Url: string }>,
  cache: Map<string, Promise<Record<string, PackageDependency[]> | null>>,
  signal?: AbortSignal
): Promise<Record<string, PackageDependency[]> | null> {
  const cacheKey = `${packageId.toLowerCase()}@${version}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const pending = (async () => {
    for (const source of sources) {
      try {
        const api = await nugetApiFactory.GetSourceApiAsync(source.Url);
        const pkg = await api.GetPackageAsync(packageId, true, signal);
        const versionEntry = pkg.data?.Versions.find(
          (entry) => compareVersions(entry.Version, version) === 0
        );
        if (!versionEntry) continue;
        const details = await api.GetPackageDetailsAsync(packageId, version, signal);
        return details.data.dependencies.frameworks;
      } catch (err) {
        Logger.debug(
          `getOutdatedPackages: dependency metadata unavailable for ${packageId} ${version}`,
          err
        );
      }
    }
    return null;
  })();

  cache.set(cacheKey, pending);
  return pending;
}

/**
 * Collects the ranges that installed packages declare on the candidate
 * packages in one condition group.
 *
 * The graph comes from `project.assets.json`: it tells us which installed
 * packages transitively pull in a candidate. Only those packages' metadata is
 * fetched, which is what makes this cheap enough to run during a scan.
 * Without restore output there is no graph, and the check is skipped (the
 * restore/rollback path still protects the workspace).
 */
function findLatestSatisfyingVersion(
  available: string[],
  constraints: PackageConstraint[]
): string | null {
  for (let i = available.length - 1; i >= 0; i--) {
    const version = available[i]!;
    if (constraints.every((constraint) => satisfiesVersionRange(version, constraint.Range))) {
      return version;
    }
  }
  return null;
}

async function collectGroupConstraintsAsync(
  packageIds: string[],
  group: InstalledPackageGroup | undefined,
  sources: Array<{ Url: string }>,
  detailsCache: Map<string, Promise<Record<string, PackageDependency[]> | null>>,
  signal?: AbortSignal
): Promise<Map<string, PackageConstraint[]>> {
  const result = new Map<string, PackageConstraint[]>();
  if (!group || packageIds.length === 0) return new Map<string, PackageConstraint[]>();

  const graphs = (await Promise.all(
    [...group.projectPaths].map((projectPath) => loadProjectDependencyGraphAsync(projectPath))
  )).filter((graph): graph is ProjectDependencyGraph => graph !== null);

  if (graphs.length === 0) {
    Logger.debug("getOutdatedPackages: no project.assets.json found — skipping dependency constraint check");
    return new Map<string, PackageConstraint[]>();
  }

  const graph = mergeDependencyGraphs(graphs, group.tfms);
  const candidateIds = new Set(packageIds.map((packageId) => packageId.toLowerCase()));
  const sourceIds = collectParentIds(candidateIds, graph.parentsByChild, graph.packageVersions);

  await processConstraintSourcesAsync({
    sourceIds,
    packageVersions: graph.packageVersions,
    sources,
    detailsCache,
    signal,
    tfms: [...graph.tfms],
    candidateIds,
    group,
    result,
  });

  return result;
}

type MergedDependencyGraph = {
  packageVersions: Map<string, string>;
  parentsByChild: Map<string, Set<string>>;
  tfms: Set<string>;
};

function mergeDependencyGraphs(graphs: ProjectDependencyGraph[], groupTfms: Iterable<string>): MergedDependencyGraph {
  const packageVersions = new Map<string, string>();
  const parentsByChild = new Map<string, Set<string>>();
  const tfms = new Set<string>(groupTfms);

  for (const graph of graphs) {
    for (const [id, version] of graph.packageVersions) {
      if (!packageVersions.has(id)) packageVersions.set(id, version);
    }
    for (const [child, parents] of graph.parentsByChild) {
      const merged = parentsByChild.get(child) ?? new Set<string>();
      for (const parent of parents) merged.add(parent);
      parentsByChild.set(child, merged);
    }
    // The assets targets are the authoritative TFM list after a restore; this
    // also covers projects where the package parser could not read a TFM.
    for (const tfm of graph.tfms) tfms.add(tfm);
  }

  return { packageVersions, parentsByChild, tfms };
}

function collectParentIds(
  candidateIds: Set<string>,
  parentsByChild: Map<string, Set<string>>,
  packageVersions: Map<string, string>
): string[] {
  // Only packages that declare a dependency edge to a candidate can constrain
  // it. The assets graph already tells us exactly who those parents are.
  const sourceIds = new Set<string>();
  for (const candidateId of candidateIds) {
    for (const parent of parentsByChild.get(candidateId) ?? []) {
      if (packageVersions.has(parent)) sourceIds.add(parent);
    }
  }
  return [...sourceIds];
}

type ConstraintSourceContext = {
  sourceIds: string[];
  packageVersions: Map<string, string>;
  sources: Array<{ Url: string }>;
  detailsCache: Map<string, Promise<Record<string, PackageDependency[]> | null>>;
  signal: AbortSignal | undefined;
  tfms: string[];
  candidateIds: Set<string>;
  group: InstalledPackageGroup;
  result: Map<string, PackageConstraint[]>;
};

async function processConstraintSourcesAsync(context: ConstraintSourceContext): Promise<void> {
  const batchSize = 5;
  for (let i = 0; i < context.sourceIds.length; i += batchSize) {
    if (context.signal?.aborted) break;
    await Promise.all(
      context.sourceIds
        .slice(i, i + batchSize)
        .map((sourceId) => addConstraintsFromSourceAsync(sourceId, context))
    );
  }
}

async function addConstraintsFromSourceAsync(
  sourceId: string,
  context: ConstraintSourceContext
): Promise<void> {
  const installedVersion = context.packageVersions.get(sourceId);
  if (!installedVersion) return;

  const frameworks = await fetchDependencyFrameworksAsync(
    sourceId,
    installedVersion,
    context.sources,
    context.detailsCache,
    context.signal
  );
  if (!frameworks) return;

  const dependencies = selectDependencyGroup(frameworks, context.tfms);
  if (!dependencies) return;

  for (const dependency of dependencies) {
    const candidateId = dependency.package.toLowerCase();
    if (!context.candidateIds.has(candidateId)) continue;
    addConstraint(context.result, candidateId, sourceId, installedVersion, dependency, context.group);
  }
}

function addConstraint(
  result: Map<string, PackageConstraint[]>,
  candidateId: string,
  sourceId: string,
  installedVersion: string,
  dependency: PackageDependency,
  group: InstalledPackageGroup
): void {
  const constraints = result.get(candidateId) ?? [];
  const duplicate = constraints.some(
    (constraint) =>
      constraint.PackageId.toLowerCase() === sourceId && constraint.Range === dependency.versionRange
  );
  if (!duplicate) {
    constraints.push({
      // Prefer the casing from the project file over the lowercased assets key
      // so the warning names the package the user sees.
      PackageId: group.direct.get(sourceId)?.id ?? sourceId,
      InstalledVersion: installedVersion,
      Range: dependency.versionRange,
    });
  }
  result.set(candidateId, constraints);
}

function formatConstraintReason(constraints: PackageConstraint[]): string {
  if (constraints.length === 0) return "no available version satisfies the installed dependency ranges";
  return constraints
    .map((constraint) => `${constraint.PackageId} ${constraint.InstalledVersion} requires ${constraint.Range}`)
    .join("; ");
}
