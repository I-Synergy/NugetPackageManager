# SonarCloud PR 46 Remediation

Status: DONE (2026-11-01)
Date: 2026-11-01
Source: `api/issues/search?componentKeys=I-Synergy_NugetPackageManager&pullRequest=46`
— **61 open issues**, all pre-existing (they surface because the PR carries the whole branch).

## Rules and planned fix

| Rule | Count | Fix |
|---|---|---|
| `S1192` duplicated string literal | 14 | Named constants (`invalidParams` becomes one shared `Protocol/ProtocolErrorCodes.cs`) |
| `S6444` regex without timeout | 12 | Pass a match timeout (`TimeSpan.FromSeconds(2)` / `matchTimeoutMilliseconds`) |
| `S3776` cognitive complexity | 6 | Extract cohesive private methods, no behaviour change |
| `S3358` nested ternary | 5 | Lift into `if`/`else` statements |
| `S8970` redundant `!` in `#nullable disable` scope | 5 | Drop the null-forgiving operator |
| `S2325` could be static | 3 | Add `static` |
| `S1118` only static members | 2 | Make the class `static` |
| `S3267` loop can be LINQ | 2 | `Where` / `Select` |
| `S2583`/`S2589` condition constant | 3 | Remove the dead branch / fix the real bug |
| `S4158` collection known empty | 1 | Remove the no-op call |
| `S3218` shadows outer member | 1 | Rename the method |
| `S2094` empty record | 1 | `ConditionNode` becomes an interface |
| `S4036` command/PATH | 2 | Resolve an absolute `dotnet` path; fix the PATH handling in `tools/quality-gate.mjs` |
| `S6966` use the async API | 1 | `await CancelAsync` |
| TS `S7721`/`S7747`/`S7772` | 3 | Hoist `unwrap`, drop the array copy in `for…of`, `node:assert` |

## Verification

`dotnet build` + `dotnet test` + `npm run typecheck` + `npm run lint` + `npm test` + `npm run quality`.

**Limitation:** SonarCloud cannot be run locally (no token), so the final confirmation of the
issue count is the next CI analysis on the PR. Fixes are made rule-by-rule, and the
behaviour-changing ones (`S2583`, `S2589`, `S4158`, `S4036`) are covered by the existing tests.
