# Batch restore: one solution restore instead of one per project

Status: DONE
Started: 2026-11-03

## Steps

- [x] group requested projects by owning solution and restore each solution once
- [x] fall back to the per-project loop (with conflict resolution) when the batched restore fails
- [x] route `runConsolidateAsync` through the same helper
- [x] tests (one command for N projects, multiple solutions, outside-solution project, fallback, single project)
- [x] verification — `npm run quality` PASS (8/8), unit suite 469 passing

## Result

| scenario | before | now |
|---|---|---|
| 152 projects, one solution | 152 csproj restores | **1 solution restore** |
| projects across two solutions | N | 2 |
| one in-solution + one outside | 2 | 2 (1 solution + 1 csproj) |
| solution restore rejects | N | failed solution attempt + N per-project (attribution kept) |
| single project | 1 | 1 (unchanged) |

## Notes

Plan: `.ai/plans/batch-restore-single-invocation.md`.
Follow-up observed in the same log: the badge scans the whole workspace (162 projects) while the
views scan the solution (152), so their scan keys differ and the single-flight does not merge them
(two `outdatedScan` jobs, 55 vs 51 results).
