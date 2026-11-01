# SonarCloud PR 46 Remediation
Status: DONE
Started: 2026-11-01

Plan: `.ai/plans/sonar-pr46-remediation.md`

## Steps
- [x] S1192 — 14 duplicated literals replaced with constants
- [x] S6444 — 12 regexes given a match timeout
- [x] S3358 / S8970 / S2325 / S1118 / S3267 — mechanical cleanups
- [x] S2583 / S2589 / S4158 / S4036 — dead-branch and path fixes
- [x] S3776 — six methods split to bring cognitive complexity under 15
- [x] S2094 / S3218 / S6966 + TS/JS issues
- [x] Verify: build, tests, typecheck, lint, npm run quality

## Notes

All 61 findings addressed. `dotnet build` + `dotnet test` (204) + `npm run typecheck` +
`npm run lint` + `npm test` (358) + `npm run quality` (8/8) all pass.

Fixes that changed code shape rather than just style:

- `ConditionNode` (empty record) became `IConditionNode`; CA1715 then required the `I` prefix,
  so the node files and every consumer were renamed.
- `CpmPropsReader.ResolveVersions` no longer pushes results through an `Action<...>` callback
  (the analyzer could not see the list being filled, which is what produced S2583/S2589).
  `Parse` and the three collectors were split out; `Order`'s redundant `ids` set was dropped.
- `TargetFrameworkResolver` now runs the muxer the sidecar itself was started with
  (`Environment.ProcessPath`), falling back to `DOTNET_HOST_PATH`, instead of bare `dotnet`.
- `tools/quality-gate.mjs` resolves `dotnet` from well-known install roots before falling back
  to PATH, and no longer runs it through a shell.
- `NdjsonServer` awaits `CancelAsync` instead of `Cancel`.

Confirmed only by the next CI analysis: SonarCloud cannot be run locally (no token).

