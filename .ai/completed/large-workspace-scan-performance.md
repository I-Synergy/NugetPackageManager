# Large-workspace scans: parse pipeline, parallelism, single-flight, snapshot

Status: DONE
Started: 2026-11-03

## Steps

- [x] Phase 1 — host time-budgeted parse pipeline (`project-parse-batch.ts`) and all call sites
- [x] Phase 1 tests — `project-parse-batch.test.ts` (chunk shrink/retry/failed paths/abort)
- [x] Phase 2 — core bounded parallel parsing in `WorkspaceModelService`
- [x] Phase 2 — shared `MsBuildProcessGate` used by `CpmEvaluator`, `TargetFrameworkResolver` and `CpmPropertyLocator`
- [x] Phase 2 tests — `WorkspaceModelServiceTests` concurrency/skip/cancel + `MsBuildProcessGateTests`
- [x] Phase 3 — `outdated-scan-coordinator.ts` single-flight + result memo + progress fan-out
- [x] Phase 3 tests — `outdated-scan-coordinator.test.ts`, `host-api.test.ts`
- [x] Phase 4 — `workspace-snapshot.ts` shared parse with invalidation by watcher/mutation/force
- [x] Phase 4 tests — `workspace-snapshot.test.ts`
- [x] Verification — `npm run quality` PASS (bundles, lint, typecheck, C# build, C# tests, TS tests, audit)

## Evidence

- `npm run quality` — PASS, 8/8 steps.
- `npm test` — 432 passing, 0 failing.
- `dotnet test NugetPackageManager.slnx -c Release` — 57 + 89 + 157 passing, 0 failing.
- `npm run lint` — 0 errors, 0 warnings.

## Notes

Plan: `.ai/plans/large-workspace-scan-performance.md` (approved 2026-11-03, all four phases).
Follow-up worth measuring before further work: on a cold aspire checkout, count how many
`dotnet msbuild` evaluations a first parse performs — the new gate makes them bounded, but
reading versions from `obj/project.assets.json` (already used for target frameworks) could
remove most of them.
