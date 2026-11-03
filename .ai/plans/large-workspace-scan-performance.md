# Large-workspace scans: stop timing out on 463-project repositories

Status: APPROVED (2026-11-03, all four phases)
Started: 2026-11-03

## Problem

On the `aspire` workspace (1 solution, 463 projects) the sidecar stops answering inside the
60 s per-request deadline (`DEFAULT_REQUEST_TIMEOUT_MS`, `nuget/core-client.ts:34`):

```
getProjects: The .NET core could not parse the workspace
  [CoreError: The .NET sidecar did not answer request 8 in time.]
getOutdatedPackages: Failed
  [CoreError: request 15/16/17 did not answer in time.]
```

Raising the timeout is **not** the fix. Four independent defects compound:

| # | Defect | Where |
|---|---|---|
| 1 | One `getProjects` RPC carries all 463 paths; the core parses them **sequentially**, spawning `dotnet msbuild` per project | `host-api.ts:2626` → `WorkspaceModelService.GetProjectsAsync` (`foreach`, line 38) |
| 2 | Three **identical, concurrent full scans**: activity-bar badge, `packages-view` count, `updates-view`. No single-flight | `extension.ts:31`, `packages-view.ts:682`, `updates-view.ts:565` |
| 3 | Scan cache is written only after a scan finishes, and the badge call never asks for it | `host-api.ts:2853`, `extension.ts:31` |
| 4 | Chunking is by **count** (47/RPC), not by time; and every tab (Updates, Consolidate, Vulnerabilities, Cleanup, project tree) re-parses all 463 projects independently | `host-api.ts:1847`, `2248`, `3721`, `3802` |
| 5 | Two independent 16-slot MSBuild semaphores (`CpmEvaluator`, `TargetFrameworkResolver`) can spawn up to 32 `dotnet` processes at once | `CpmEvaluator.cs:22`, `TargetFrameworkResolver.cs:27` |

Timeline proof: requests 15/16/17 start at 12:03:05.6 and all die at 12:04:05.6 — three scans'
first chunks expiring on the same second. `getPackages` returned 50 packages in 1 s, so feeds,
credentials and `nuget.config` are healthy.

## Goal

A large workspace loads in one parse, one scan, and no request depends on a fixed wall-clock
deadline:

1. `getProjects` completes well inside the deadline on 463 projects and never sends one
   unbounded batch.
2. Concurrent `getOutdatedPackagesAsync` callers share **one** scan and one result.
3. Every tab reads the same workspace snapshot instead of re-parsing the repository.
4. The core bounds both per-project parallelism and total `dotnet` process count.
5. A timed-out or cancelled caller detaches from shared work; it never kills it.

## Design

### Phase 1 — Host: time-budgeted parse pipeline (TypeScript)

> **Superseded 2026-11-03** by `.ai/plans/workspace-scan-job.md`: the chunk loop was a
> transport workaround. The core now streams per-project progress and `getProjects` is a job,
> so `project-parse-batch.ts` was deleted. The rest of this plan (Phases 2–4) still stands.

New `src/NugetPackageManager.VSCode.Host/utilities/project-parse-batch.ts`:

```ts
export type ParseProgress = { completed: number; total: number };
export type ParseResult = { projects: Project[]; failedPaths: string[] };

parseProjectsBatchedAsync(projectPaths, {
  signal?, onProgress?, targetChunkMs = 15_000, initialChunkSize = 8,
}): Promise<ParseResult>
```

- Adaptive chunk size: start at 8, target 15 s per core RPC, grow on fast chunks (×1.5,
  cap 128), shrink on a `timeout` (÷2, floor 1).
- On chunk timeout: retry once at the smaller size; if a **single** project still times out,
  record it in `failedPaths` and continue. One pathological project must not fail the load.
- Cancellation: an aborted `signal` rejects the caller immediately; the helper stops issuing
  chunks.
- Preserves order and de-duplicates paths.

Replace every all-at-once call site: `parseProjectsAsync` (`host-api.ts:250`),
`parseOutdatedProjectsAsync` (`:1838`, delete the fixed `chunkSize` at `:1847`),
`parseProjectsForScanAsync` (`:2248`), `collectUsedPackagesAsync` (`:3721`), the cleanup path
(`:3802`). `getProjectsAsync` logs `Parsed N project(s) in Xms`.

### Phase 2 — Core: bounded parallel parsing, shared MSBuild gate (C#)

`src/NugetPackageManager.Core.Workspace/WorkspaceModelService.cs`

- `GetProjectsAsync` → `Parallel.ForEachAsync` over the distinct paths with
  `MaxDegreeOfParallelism = options.ParseConcurrency`
  (default `Math.Clamp(Environment.ProcessorCount, 2, 16)`), collecting into a
  `ConcurrentBag<ProjectModel>` and sorting once at the end.
- Keep current failure semantics (skip `IOException`/`XmlException`/`UnauthorizedAccessException`,
  return fewer projects) and cancellation.
- Internal constructor parameter for the concurrency so tests can pin it.

New `src/NugetPackageManager.Core.Workspace/Projects/MsBuildProcessGate.cs`

- Process-wide `SemaphoreSlim` (`Math.Clamp(Environment.ProcessorCount * 2, 4, 16)`), injected
  into `CpmEvaluator` and `TargetFrameworkResolver` via an optional constructor parameter
  (default: the shared singleton). Both evaluators wait on it **before** spawning `dotnet`, so
  the two caches can no longer combine into 32 processes.
- Debug diagnostics: evaluations run, cache hits, total wall time, peak concurrency.

### Phase 3 — Host: single-flight outdated scans (TypeScript)

New `src/NugetPackageManager.VSCode.Host/utilities/outdated-scan-coordinator.ts`

- `RunAsync(key, runner)` returns the in-flight promise for `key` when one exists, else starts
  `runner`. Key = the existing `BuildScanCacheKey(...)` (workspace roots, project paths,
  sources, prerelease, exclude globs).
- Progress fan-out: `ScanProgress.Begin/Report` is applied to **every** attached `ScanId`, so
  badge, `packages-view` and `updates-view` all get determinate progress.
- Short-lived result memo (single entry, 5 min) so a second caller returns without a scan.
  `ForceReload` starts a new generation and leaves current callers on their own promise.
- `getOutdatedPackagesAsync` becomes a thin wrapper; the badge call site stops being a
  separate full scan.

### Phase 4 — Host: one workspace snapshot for every tab (TypeScript)

New `src/NugetPackageManager.VSCode.Host/utilities/workspace-snapshot.ts`

- `GetAsync({ forceReload, signal, onProgress }) -> { projects, projectFiles }` with
  single-flight and a generation counter.
- Invalidation: `ForceReload`; a debounced `FileSystemWatcher` on
  `**/*.{csproj,fsproj,vbproj,props,targets}`; and an explicit `Invalidate()` called by every
  mutation path (`updateProjectAsync`, `batchUpdatePackagesAsync`, `consolidatePackagesAsync`,
  `cleanupUnusedPackagesAsync`, `updateCentralVersionsAsync`).
- Consumers: `getProjectsAsync`, outdated scan, `getInconsistentPackagesAsync`,
  `getVulnerablePackagesAsync`, cleanup report and `cleanupUnusedCpmPackageAsync`. Callers with
  `ProjectPaths` filter the snapshot instead of re-parsing.
- Each caller's `AbortSignal` detaches that caller only; shared work keeps running and
  populates the snapshot.

### Phase 5 — Verification

**C#**

- `WorkspaceModelServiceTests`: parallel parse returns every project sorted; unreadable
  project skipped; cancellation stops early; a fake evaluator asserting observed concurrency
  never exceeds `ParseConcurrency`.
- `MsBuildProcessGateTests`: peak concurrent holders ≤ limit.

**TypeScript**

- `project-parse-batch.test.ts`: chunk shrink after a stubbed `timeout`, retry, single-project
  timeout recorded in `failedPaths`, progress monotonic, abort stops issuing.
- `outdated-scan-coordinator.test.ts`: two concurrent calls → one runner, both resolve; both
  scan ids receive progress; memo hit inside the window; `ForceReload` starts a new run.
- `workspace-snapshot.test.ts`: cache hit, file-save invalidation, mutation invalidation,
  force reload, detached aborts.
- `host-api.test.ts`: `getProjects` issues multiple bounded `getProjects` RPCs, not one;
  concurrent `getOutdatedPackagesAsync` hits the core once.

**Commands** (all must pass): `npm run esbuild`, `npm run typecheck`, `npm run lint`,
`npm test`, `dotnet test NugetPackageManager.slnx -c Release`, then `npm run quality`.

**Manual acceptance** on a ≥400-project workspace: cold load under 60 s; badge, Updates tab and
packages-view produce one core `getProjects` sequence; `Updating configuration` no longer
restarts a cold scan; no `CoreError: ... did not answer request ... in time` in the log.

## Risks

- Parallelism in the core: every touched type must be thread-safe. `ProjectFileReader` is
  static/pure, `cpmCache` is concurrent, both evaluator caches are lock-guarded — verified
  before editing.
- Snapshot caching can serve stale data after a write; every mutation path must call
  `Invalidate()`, and the watcher covers external edits. Tests cover both.
- Memory: 463 `ProjectModel` instances are already held per scan today; holding one snapshot
  is strictly less.

## Out of scope / follow-up

Replacing per-project `dotnet msbuild` evaluation with values read from
`obj/project.assets.json` (already used for target frameworks) would cut cold evaluation cost
by an order of magnitude. Keep it separate: with the diagnostics added in Phase 2 we can
measure how many evaluations a cold aspire scan actually performs and decide with data.
