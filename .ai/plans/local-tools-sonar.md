# Fix SonarCloud findings on PR 56

Status: IN PROGRESS
Created: 2026-11-04
Source: SonarCloud PR 56 (`sinceLeakPeriod=true`, OPEN/CONFIRMED) — 5 issues, 29 min debt

## Findings

| Rule | File | Line | Message |
|---|---|---|---|
| csharpsquid:S3776 | `Core.Workspace/Tools/LocalToolManifestReader.cs` | 116 | Cognitive Complexity 20 > 15 (`ReadTools`) |
| csharpsquid:S3776 | `Core.Workspace/Tools/LocalToolManifestWriter.cs` | 204 | Cognitive Complexity 20 > 15 (`LocateVersion`) |
| csharpsquid:S1066 | `Core.Workspace/Tools/LocalToolManifestWriter.cs` | 245 | Merge nested `if` (`String` token + `IsToolVersion`) |
| csharpsquid:S3776 | `Core.Workspace/Tools/LocalToolManifestWriter.cs` | 340 | Cognitive Complexity 24 > 15 (`Compare`) |
| csharpsquid:S3776 | `Core/Toolchain/ToolchainAnalysis.cs` | 254 | Cognitive Complexity 20 > 15 (`EvaluateLocalTools`) |

All five are in code added by this PR, so they are leak-period findings, not pre-existing debt.

## Refactors (behaviour-preserving, no suppressions)

- `ReadTools`: keep the two container checks in `ReadTools`, move the per-entry work into
  `ReadTool(...)` and the duplicate-command bookkeeping into `RecordCommands(...)`.
- `LocateVersion`: move the container-stack token handling into
  `TryReadContainerToken(tokenType, containers, ref pendingName)` plus a `PopContainer` helper, and
  merge the `String` + `IsToolVersion` checks into one condition (also clears S1066).
- `Compare`: keep the value-kind equality check in `Compare`, move the object walk into
  `CompareObject(...)` and the array walk into `CompareArray(...)`; extract the
  `"/tools/{toolId}/version"` special case into `IsTargetVersion(path, toolId)` /
  `AssertTargetVersion(value, version, path, manifestPath)`.
- `EvaluateLocalTools`: call `AddInvalidManifestIssue(...)` and
  `CollectMissingTools(manifest, notRestored)` / `AddNotRestoredIssue(...)` per manifest.

No public signature changes, no behaviour change, no analyzer suppression. Sonar's cognitive
complexity counts each extracted helper separately, so each stays under 15.

## Steps

- [ ] Step 1: refactor the reader and writer helpers
- [ ] Step 2: refactor `EvaluateLocalTools`
- [ ] Step 3: `dotnet build` + MSTest suites + `npm run quality`
- [ ] Step 4: commit, push to `feat/local-dotnet-tools`, wait for SonarCloud re-analysis, confirm
      `api/issues/search` returns 0 for PR 56

## Verification

- `dotnet build NugetPackageManager.slnx -c Release` — clean.
- `dotnet test` — the existing LocalTool/Toolchain suites must stay green; no test changes are
  expected because behaviour is unchanged.
- `npm run quality` — 8/8.
- SonarCloud PR 56 issue query returns `total: 0`.
