# Workspace parse as a job: core progress, one call, no chunking

Status: APPROVED (2026-11-03, user: "go")
Started: 2026-11-03
Supersedes: Phase 1 of `.ai/plans/large-workspace-scan-performance.md`

## Problem

Phase 1 worked around a host-side deadline by chunking `getProjects` in TypeScript. That is
the wrong layer for the loop: the deadline belongs to the host, but the *progress* belongs to
the core, and the core already knows how far it is. The chunk loop exists only because the
NDJSON protocol is request/response — there is no way for the core to say "42 of 463 parsed".

The webview also has its own 120 s deadline (`RPC_TIMEOUT_MS`) on `getProjectsAsync`, so a cold
463-project parse can still fail on the client even when the host is healthy.

## Goal

- One `getProjects` RPC parses the whole workspace; the core streams per-project progress.
- `project-parse-batch.ts` (adaptive chunking) is deleted, not kept alongside.
- The project tree starts a **job** and polls it, so no client deadline applies and the
  spinner shows real progress.
- A hung sidecar is still detected: progress is a liveness signal, so the call gets a long
  overall cap plus a short *stall* timeout instead of a flat 60 s wall clock.

## Design

### 1. Protocol: core → host progress (C#)

`src/NugetPackageManager.Core/Protocol/`

- New message: `{"type":"progress","id":<requestId>,"stage":"...","percent":N,"completed":n,"total":m}`,
  written through the existing `writeLock`.
- `RpcHandler` (existing, unchanged) stays for every handler. Add:
  ```csharp
  public sealed class RpcContext { long RequestId { get; } Task ReportProgressAsync(string stage, int percent, int completed = 0, int total = 0); }
  public delegate Task<object?> ContextRpcHandler(JsonElement parameters, RpcContext context, CancellationToken cancellationToken);
  ```
  `NdjsonServer` accepts an optional second dictionary of `ContextRpcHandler`; it wins over a
  plain handler with the same name. Every other handler keeps its signature — no churn.
- `Program.cs`: merge `WorkspaceHandlers.CreateContextHandlers()` into the new dictionary.
- `WorkspaceHandlers.HandleGetProjectsAsync` takes the context and forwards to
  `WorkspaceModelService.GetProjectsAsync(..., progress)`.

`src/NugetPackageManager.Core.Workspace/WorkspaceModelService.cs`

- New optional `IProgress<ProjectParseProgress>? progress` parameter on `GetProjectsAsync`
  (`ProjectParseProgress(string ProjectPath, int Completed, int Total)`).
- Report after each project finishes (success *or* skip), from `Parallel.ForEachAsync`;
  `Interlocked.Increment` counter, `IProgress.Report` is thread-safe.
- No behaviour change when `progress` is null.

### 2. Host transport: progress, cap and stall guard (TypeScript)

`src/NugetPackageManager.VSCode.Host/nuget/core-client.ts`

- `CoreCallOptions = { timeoutMs?, stallTimeoutMs?, onProgress? }` as an optional 4th argument:
  `CallAsync<T>(method, params, signal?, options?)`. Existing 3-argument calls are unchanged.
- `HandleLine`: a `type === "progress"` message with a pending id invokes that call's
  `onProgress` and returns **without** settling the call.
- `stallTimeoutMs`: reset on every progress message; when it elapses with no progress the call
  rejects with `CoreError("timeout", "…stopped reporting progress…")` and sends `cancel`.
  `timeoutMs` stays the overall cap.
- Defaults unchanged for every other call.

### 3. Host: one-call parse, chunking deleted (TypeScript)

- `parseProjectsAsync` (`host-api.ts:250`) becomes the real parse path: one `getProjects` call
  with `{ projectPaths, extraTargetFrameworks, reportProgress: true }`, a 15-minute cap, a
  120 s stall timeout, and an `onProgress` that forwards `(completed, total)`.
- Delete `utilities/project-parse-batch.ts` and its test. Call sites revert to the single call:
  `getProjectsAsync`, `parseOutdatedProjectsAsync` (progress from the core instead of chunk
  math), `parseProjectsForScanAsync`, `collectUsedPackagesAsync`, `cleanupUnusedCpmPackageAsync`.
  `failedPaths` becomes "discovered minus parsed", reported where a conservative caller needs it.
- `parseWorkspaceProjectsAsync` in the snapshot integration forwards progress into
  `workspaceSnapshot`'s `onProgress`.

### 4. Job: `workspaceScan` (TypeScript)

- `types.ts`: `JobKind` gains `"workspaceScan"`; `GetJobResponse` gains
  `JobStatus<"workspaceScan", GetProjectsResponse>`; new
  `startWorkspaceScanAsync(req: CacheControl): Promise<Result<StartJobResponse>>`.
- `operation-jobs.ts`: `OperationJobs.Workspace = new JobRegistry<GetProjectsResponse>("workspaceScan")`,
  included in `Get`/`Cancel`/`Reset` (doc note: a long read using the same polling contract).
- `host-api.ts`: `startWorkspaceScanAsync` starts a job that drives
  `workspaceSnapshot.GetAsync({ forceReload, onProgress })` and reports
  `Parsing projects (N/M)…` / `0–100 %`. `getProjectsAsync` stays and keeps returning the same
  snapshot (single-flight absorbs a concurrent job), so no existing caller breaks.
- Cancelling the job stops the job; the shared parse may finish and warm the snapshot (next
  view gets it instantly). Documented.

### 5. Webview: start + poll (TypeScript)

- `webview/jobs.ts`: `runWorkspaceScanJobAsync(request, options) -> Result<GetProjectsResponse>`,
  same shape as the other runners.
- `packages-view.LoadProjectsAsync`: start the job, feed `Stage`/`Percent` into
  `projectsLoadingMessage`, and treat `_projectsAc` as "stop waiting" (the host keeps parsing
  and caches the result). No behaviour change to the rest of the load sequence.

## Tests

**C#**
- `NdjsonServerTests`: a progress message is written with the request id and does not settle the
  request; a handler without a context still works.
- `WorkspaceModelServiceTests`: progress reports `Completed` 1..N for a batch of 20, never
  exceeds `Total`, and is null-safe.

**TypeScript**
- `core-client.test.ts`: progress lines reach `onProgress` and do not resolve; a stall rejects
  with `timeout` and sends `cancel`; an overall cap still fires.
- `host-api.test.ts`: `getProjects` issues exactly **one** core call for N projects and forwards
  progress; delete the chunk-count assertions.
- Delete `project-parse-batch.test.ts`.
- `operation-jobs.test.ts`: the new kind is dispatched by `getJobAsync` and cancellable.
- `packages-view.test.ts`: the load path starts the job and renders its stage.

## Verification

`npm run quality` (bundles, lint, typecheck, C# build + tests, TS tests, audit), then
`npm test` and `dotnet test` counts recorded. Manual check on a ≥400-project workspace: one
`getProjects` request in the log, project tree shows `Parsing projects (N/M)`, no
`CoreError ... did not answer in time`.

## Risks

- **Protocol skew.** A new core with an old host would resolve a progress message early. Both
  halves ship in one VSIX and `npm run quality` rebuilds `dist/core`; accepted and noted.
- **Stall guard false positive.** Only applies when `onProgress` is requested. Progress is
  emitted per finished project, and with bounded parallelism a 16-project stall is the worst
  case before the guard fires at 120 s.
- **Cancellation semantics.** Cancelling the job leaves the shared parse running; that is
  deliberate (the result is still useful) and documented in the RPC doc comment.
