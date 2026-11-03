# Aspire parse cost: CPM resolver, Arcade assets, scan job

Status: DONE
Started: 2026-11-03

## Steps

- [x] Phase A — `CpmPropertyResolver` (props chain, literal substitution)
- [x] Phase A2 — partial resolution + per-project `needsEvaluation`
- [x] Phase A — wire into `WorkspaceModelService.LoadCpmMap` + tests
- [x] Phase B — Arcade `artifacts/obj` assets lookup + tests
- [x] Phase D — gate capacity default lowered to 8
- [x] Cache bounds — 500 entries evicted repos >500 projects; now 16 384
- [x] Diagnostics — one `getProjects: …` line per parse on stderr
- [x] Phase C — `outdatedScan` job + view polling (TS)
- [x] Verification — quality gate + 522-project replay + test VSIX

## Baseline (aspire, 522 projects, this machine, 12 cores)

| | Before | After |
|---|---|---|
| 30 projects | 40.5 s | ~9.9 s → now part of the 14 s full run |
| 522 projects, cold | ~700 s (extrapolated from 30) | **14.1 s** |
| 522 projects, warm (same sidecar) | ~700 s (cache thrash) | **56 ms** |
| `dotnet msbuild` evaluations, cold | ~1 700 | **14** |
| warm | ~1 700 | **0** |

Diagnostic line: `getProjects: 522 project(s) in 14087ms (14 msbuild evaluation(s), 8 in flight at peak)`.

## Evidence

- `npm run quality` — PASS, 8/8 steps; C# 335 passing, TS 457 passing.
- VSIX `2026.11103.11434` (9.52 MB, 41 files), manifest verified.
- Remaining 14 evaluations: projects whose own `PackageReference` version is an expression, and
  multi-target projects without a usable assets file. Correctness beats a few seconds here.

## Notes

Plan: `.ai/plans/aspire-parse-cost.md`.
