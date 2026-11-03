# Batch update: restore the owning solution once, not every project

Status: APPROVED (2026-11-03, from the I-Synergy test run)
Started: 2026-11-03

## Symptom

A 51-package batch update on a 152-project solution runs **152 sequential
`dotnet restore <one csproj>`** commands (~10 s each → ~25 minutes):

```
batchUpdatePackages: Updating 51 packages
batchUpdatePackages: Updated Aspire.Azure.Messaging.ServiceBus to 13.6.4
...
TaskExecutor.ExecuteCommandAsync: dotnet restore .../ISynergy.Service.Api.csproj
TaskExecutor.ExecuteCommandAsync: Completed successfully
TaskExecutor.ExecuteCommandAsync: dotnet restore .../ISynergy.Service.Jobs.Database.EventSourcing.csproj
...
```

## Cause

`restoreProjectsInternalAsync` (`host-api.ts:3946`) is a `for` loop over every path it is given,
and each iteration calls `restoreOneProjectAsync` → `dotnet restore <that project>`. The batch
passes `allProjectPaths` — the union of every affected project (all 152 for a CPM bump) — so the
whole solution is restored one process at a time. `runConsolidateAsync` (`:1484`) has its own copy
of the same loop.

It was written that way to attribute a failure to a project, name it in the progress bar, and pick
the project's nearest `global.json` for the SDK. Those goals matter only when a restore **fails**;
on the success path the per-project granularity just costs hours.

## Fix

Restore the **owning solution once**, and fall back to the per-project loop only when that fails.

`restoreProjectsInternalAsync(paths, signal, allowConflictResolution, onProgress)`:

1. When more than one path is requested, group them by solution:
   - discover `*.{sln,slnx}` at the workspace roots (`findFiles`, same as project discovery),
   - `parseSolutionProjectPathsAsync` each (already exists) and normalize the paths,
   - a requested path belongs to the first solution that lists it.
2. For each solution group, run **one** `dotnet restore <solution>` with
   `CreateDotnetOptions(solutionPath)`; report `Restoring <solution name> (N project(s))…`.
   Paths no solution covers keep the per-project restore.
3. If any batched restore throws (or is cancelled), run the existing per-project loop over all
   requested paths so the failure is attributed exactly as today (conflict detection included),
   and log that the batched restore fell back.
4. Single-project requests keep the current behaviour.

`runConsolidateAsync`: replace its private loop with `restoreProjectsInternalAsync` so
consolidation gets the same batching (it currently ignores the return value; keep ignoring it).

Progress stays compatible: `onProgress` keeps its `{ projectPath, index, total, stage, percent }`
shape, with the solution path as `projectPath` for a batched restore.

## Tests

`host-api.test.ts` (TaskExecutor is already stubbed there):

- a batch update across N projects of one solution issues **one** `dotnet restore <*.slnx>` and
  none per project;
- a request naming projects from two solutions issues one restore per solution;
- a project outside any solution is still restored individually;
- when the solution restore rejects, the fallback issues the per-project restores and the failure
  is attributed to the offending project;
- a single-project request still issues exactly one per-project restore.

## Verification

`npm run quality`, then a test VSIX. On the I-Synergy solution a 51-package update must show one
restore stage instead of 152, and finish in minutes rather than tens of minutes.

## Observed while diagnosing (separate follow-up, not this plan)

The same log shows the badge scan covering **162** projects (workspace-wide) and the views **152**
(solution-restricted), so their scan cache keys differ and the "one scan per activation" dedupe
does not kick in (55 vs 51 results, two `outdatedScan` jobs started 1 ms apart). Canonicalizing
the scope to the solution set for both would make them share a run.
