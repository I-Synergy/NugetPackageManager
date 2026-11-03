# Scan cancellation and scope canonicalization

Status: DONE
Started: 2026-11-03

## Steps

- [x] `isCancellation` helper for host-side error classification
- [x] `getOutdatedPackagesAsync` / `loadWorkspaceProjectsAsync` return a cancellation result without logging an error
- [x] `WorkspaceSnapshotCache.knownProjectFiles()` without starting a parse
- [x] canonicalise `ProjectPaths` in `prepareOutdatedScanAsync`
- [x] coordinator debug logging for started vs attached
- [x] tests (host-api, workspace-snapshot)
- [x] verification + new test VSIX

## Evidence

- `npm run quality` — PASS, 8/8 steps (TS suite 443 passing).
- VSIX rebuilt twice: `2026.11103.11336` (9.51 MB, 41 files) after `.vscodeignore` gained
  `coverage/**`; manifest identity verified.
- Trigger: aspire log at 13:28:08 showed three `getOutdatedPackages` calls and two
  `AbortError` "Failed" entries from webview cancels.

## Notes

Plan: `.ai/plans/scan-cancellation-and-scope.md`.
The scope canonicalisation only applies once discovery has produced the project list; if a view
scan arrives first it keeps its own key and starts its own run (intended fallback).
