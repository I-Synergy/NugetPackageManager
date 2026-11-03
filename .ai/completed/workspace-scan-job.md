# Workspace parse as a job: core progress, one call, no chunking

Status: DONE
Started: 2026-11-03

## Steps

- [x] Phase A1 — NDJSON `progress` message + `RpcContext` in `NdjsonServer`
- [x] Phase A2 — `WorkspaceModelService.GetProjectsAsync` reports per-project progress
- [x] Phase A3 — C# tests (protocol progress, workspace progress)
- [x] Phase B1 — `CoreClient` progress + stall guard (`core-client.ts`)
- [x] Phase B2 — one-call `parseProjectsAsync`, delete `project-parse-batch.ts`
- [x] Phase B3 — `workspaceScan` job kind and `startWorkspaceScanAsync`
- [x] Phase B4 — webview `runWorkspaceScanJobAsync` + `packages-view` polling
- [x] Phase B5 — TypeScript tests (core-client, host-api, operation-jobs, packages-view)
- [x] Verification — `npm run quality`, `npm test`, `dotnet test`, real sidecar wire check

## Evidence

- `npm run quality` — PASS, 8/8 steps.
- `dotnet test NugetPackageManager.slnx -c Release` — 308 passing (57 + 91 + 160), 0 failing.
- `npm test` — 439+ passing, 0 failing (last run inside the quality gate).
- Real sidecar check: `dotnet dist/core/NugetPackageManager.Core.dll` answers
  `{"type":"progress","id":1,"stage":"Parsing projects (1/1)…","percent":100,"completed":1,"total":1}`
  before `{"id":1,"ok":true,...}`.

## Notes

Plan: `.ai/plans/workspace-scan-job.md` (approved 2026-11-03, user: "go").
`project-parse-batch.ts` and its test are deleted; the adaptive chunk loop described in
`.ai/plans/large-workspace-scan-performance.md` Phase 1 no longer exists.
