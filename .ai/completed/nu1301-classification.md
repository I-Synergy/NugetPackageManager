# Explain an unreachable NuGet source correctly

Status: IN PROGRESS
Started: 2026-11-11
Plan: `.ai/plans/nu1301-classification.md`

## Steps

- [x] Reorder classification: environment failures before restore conflicts
- [x] Name the missing local source in the summary/hint; keep the URL hint
- [x] Add the classifier regression tests
- [x] Build + run the core tests
- [x] Full `npm run quality` and diff review

**Status:** DONE

## Result

- Classification order is now SDK → vulnerability audit → **environment** → restore conflict, so a
  source failure can never be explained as a version conflict.
- `NU1301` naming a missing local folder reports that path and tells the user to remove/disable the
  source; URL sources keep the network/proxy/credentials hint.
- Two regression tests added; `Core.Tests` 112 passed; `npm run quality` PASS 8/8.
- The machine's stale source (`Microsoft Visual Studio Offline Packages`) is disabled at user level;
  a plain `dotnet restore NugetPackageManager.slnx` now succeeds.

## Notes

- The user's stale source (`Microsoft Visual Studio Offline Packages`) has been disabled; a plain
  `dotnet restore` now succeeds.
- No restore-behaviour change: the extension still uses every configured source.
