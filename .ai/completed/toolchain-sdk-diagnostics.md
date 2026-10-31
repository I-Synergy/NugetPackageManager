# Toolchain-aware restore: SDK selection, failure classification, actionable UI

**Status:** DONE
Started: 2026-10-31
Completed: 2026-10-31
Plan: `.ai/plans/toolchain-sdk-diagnostics.md`

## Steps

- [x] 2.1 `dotnet-context.ts` + `cwd` in `TaskExecutor` and `ProjectFrameworkResolver`
- [x] 2.2 `dotnet-failure.ts` classifier wired into restore errors
- [x] 2.3 `getToolchainHealthAsync` RPC + diagnostics command
- [x] 2.4 `<actionable-error>` and `<toolchain-banner>`, wired into views
- [x] 2.5 Host + web tests
- [x] 2.6 README and CHANGELOG

## Notes

- Root cause fixed: `spawn`/`execFile` now receive `cwd` = directory of the project's nearest
  `global.json` (`CreateDotnetOptions`, `ResolveDotnetContext`). All 8 `dotnet` call sites plus
  the framework resolver pass it.
- Framework resolver now logs the failure at warn level and records `EvaluationFailed` instead of
  silently degrading to XML.
- `DotnetError.failure` carries a classified cause; `BatchUpdateResponse.Failure` exposes it to the
  UI. Single-project failures (`fail(string)`) only carry summary + hint in the message text — the
  RPC `Result` error type is a string, extending it was out of scope.
- Cleanup/consolidate/vulnerabilities views were left with their existing error rendering: they
  receive only string errors from the RPC boundary. The banner and the Updates tab cover the
  toolchain case.
- Verification: `npx tsc --noEmit` clean, `npm run lint` 0 errors / 5 warnings (complexity and
  regex advisories, same class as existing baseline), `npx vscode-test` 460 passing (baseline 434).
