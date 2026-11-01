# C# Test Utility Layer

Status: DONE
Started: 2026-11-01
Finished: 2026-11-01

## Steps
- [x] Step 1: create TestUtilities project
- [x] Step 2: add TestPaths + TemporaryDirectory
- [x] Step 3: move fixtures into the project
- [x] Step 4: reference the project from the test suites
- [x] Step 5: migrate the duplicated C# helpers
- [x] Step 6: update TS consumer + build excludes
- [x] Step 7: update docs + solution
- [x] Step 8: verify (dotnet build/test, typecheck, TS suite)

## Verification
- `dotnet build NugetPackageManager.slnx -c Release` — succeeded (analyzers, warnings-as-errors).
- `dotnet test NugetPackageManager.slnx -c Release --no-build` — 172/172 (14 + 89 + 69).
- `npm run typecheck`, `npm run test-compile`, `npm run lint` — clean.
- `npm test` — 374 passing, exit 0.
- `validate-agents-md.py`, `validate-prose.py`, `git diff --check` — clean.

## Notes
- The three fixture-reading classes hold `TemporaryDirectory` in a field, so CA1001 is suppressed at
  class level with the MSTest lifecycle as justification; `CpmPropsReaderTests` uses `using var`
  locals instead and needs no suppression.
- `TemporaryDirectory` and `TestPaths` are the only shared helpers so far; the remaining C#
  duplication is XML fixture literals (props/csproj snippets), deliberately not abstracted.
