# Explain an unreachable NuGet source correctly

Status: IN PROGRESS
Started: 2026-11-11
Progress: `.ai/progress/nu1301-classification.md`

## Problem

An update restore failed with:

```
error NU1301: The local source 'C:\Program Files (x86)\Microsoft SDKs\NuGetPackages\' doesn't exist.
```

but the UI showed the hint for a version conflict: "Pin the contested package to a single version
(the Consolidate tab can do this) and restore again."

Cause: `RestoreOutput.Parse` treats **every** `error NUxxxx:` line as a `RestoreConflict`, and
`DotnetFailureClassifier.Classify` runs `ClassifyRestoreFailure` **before**
`ClassifyEnvironmentFailure`. NU1301 therefore lands in `Conflicts`, the conflict branch wins, and
the source failure is explained as a dependency conflict.

The machine itself has a stale user-level source (now disabled):
`%APPDATA%\NuGet\NuGet.Config` → `Microsoft Visual Studio Offline Packages` →
`C:\Program Files (x86)\Microsoft SDKs\NuGetPackages\` (folder absent).

## Changes (core only)

`src/NugetPackageManager.Core/Diagnostics/DotnetFailureClassifier.cs`

1. Classify environment failures (source unreachable, password script) **before** restore
   conflicts, so a transport/source error is never reported as a version conflict.
2. For `SourceUnavailable`, name the source in the summary and give an actionable hint:
   - local path (NU1301 `The local source '<path>' doesn't exist`): "The NuGet source '<path>'
     does not exist." / hint: remove or disable that source (`dotnet nuget list source` then
     `dotnet nuget disable source <name>`, or fix `packageSources` in `nuget.config`) and restore
     again.
   - URL (`Unable to load the service index for source …`): keep the network/proxy/credentials hint.

## Tests

`tests/NugetPackageManager.Core.Tests/Diagnostics/DotnetFailureClassifierTests.cs`

1. NU1301 + a parsed `->` chain → `SourceUnavailable` (ordering regression), summary contains the
   path, hint mentions disabling the source.
2. Unreachable URL → `SourceUnavailable`, hint mentions network/proxy/credentials.
3. Existing NU1107 conflict test still classifies as `RestoreConflict`.

## Verification

`dotnet build NugetPackageManager.slnx -c Release` (plain restore now works after the stale source
was disabled), `dotnet test tests/NugetPackageManager.Core.Tests -c Release`, then the full
`npm run quality`.

## Out of scope

- Changing restore behaviour (no `--ignore-failed-sources`, no source rewriting).
- Editing the user's `nuget.config` from the extension.
