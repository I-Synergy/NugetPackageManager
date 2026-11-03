# Scan cancellation: stop logging a cancel as a failure, and collapse duplicate scans

Status: APPROVED (2026-11-03, follow-up to the aspire test run)
Started: 2026-11-03

## Observed

Running `2026.11103.11322` against aspire, the project tree is fixed (`workspaceScan` job,
463 projects in ~11 s, no timeout), but the log shows:

```
13:28:08.480 [INFO] getOutdatedPackages: Checking for outdated packages
13:28:08.483 [INFO] getOutdatedPackages: Checking for outdated packages
13:28:08.484 [INFO] getOutdatedPackages: Checking for outdated packages
13:28:08.486 [ERROR] getOutdatedPackages: Failed [DOMException [AbortError]: This operation was aborted
    at RpcHost.handleMessageAsync ... AbortController.abort
13:28:08.495 [ERROR] getOutdatedPackages: Failed [DOMException [AbortError]: ...
```

## Diagnosis

1. **A caller cancellation is logged as a failure.** `RpcHost` aborts the handler's
   `AbortController` when the webview sends `rpc-cancel` (a view re-render/`@lit/task` re-run).
   `outdatedScans.RunAsync` correctly rejects **only that caller**, but
   `getOutdatedPackagesAsync`'s `catch` treats any rejection as an error and logs it. Nothing
   failed; the shared scan keeps running. Same shape in `loadWorkspaceProjectsAsync`
   (`getProjects`/`workspaceScan`).
2. **The badge scan and the view scans never share a run.** The cache key is built from
   `request.ProjectPaths`. The badge sends none (`[]`), while `packages-view` always sends all
   463 paths and `updates-view` forwards them, so the views' key differs and they start their
   own scan instead of attaching to the badge's in-flight one. On a 463-project repo that is a
   second full metadata walk, and the views then cancel it — producing the log above.

## Fix

1. `src/NugetPackageManager.VSCode.Host/utilities/cancellation.ts` (new):
   `isCancellation(error)` — true for `CoreError` with code `cancelled` and for a DOM
   `AbortError`.
2. `getOutdatedPackagesAsync` and `loadWorkspaceProjectsAsync`: when the caller cancelled, log at
   debug and return `fail("The request was cancelled.")` — no `Logger.error`, no misleading
   "Failed to check for outdated packages" text.
3. `WorkspaceSnapshotCache.knownProjectFiles(): string[] | null` — the cached snapshot's files,
   or the files the in-flight discovery already found, **without starting a parse**. `SharedParse`
   records `discovered` as soon as `discover()` resolves.
4. `prepareOutdatedScanAsync` canonicalises the scope for the cache key: a `ProjectPaths` list
   that covers every known project is the same scan as no list, so it is keyed as `[]` and
   attaches to the badge's run. Left untouched when the snapshot is unknown or the request is a
   genuine subset.
5. `OutdatedScanCoordinator`: debug-log `started` vs `attached` (key + attached caller count) so
   the next log tells the truth.

## Tests

- `host-api.test.ts`: a pre-aborted signal on `getOutdatedPackagesAsync` and on `getProjectsAsync`
  returns `fail("The request was cancelled.")`; concurrent badge-shaped (no `ProjectPaths`) and
  view-shaped (full project list) scans reach the core's `getProjects` once.
- `workspace-snapshot.test.ts`: `knownProjectFiles()` is null before discovery, returns the
  discovered list while the parse is in flight, and the cached list afterwards.
- `outdated-scan-coordinator.test.ts`: a cancel still rejects only that caller (already covered;
  keep green).

## Verification

`npm run quality`, then rebuild a test VSIX; the aspire log must show no `AbortError` at ERROR
and one scan per activation.
