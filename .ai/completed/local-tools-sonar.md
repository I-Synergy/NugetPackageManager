# Fix SonarCloud findings on PR 56
Status: DONE
Started: 2026-11-04
Plan: `.ai/plans/local-tools-sonar.md`

## Steps
- [x] Step 1: refactor the reader and writer helpers
- [x] Step 2: refactor `EvaluateLocalTools`
- [x] Step 3: `dotnet build` + MSTest suites + `npm run quality`
- [x] Step 4: commit, push, wait for SonarCloud, confirm 0 issues

## Notes

### Findings (PR 56, leak period, OPEN/CONFIRMED)
- `csharpsquid:S3776` `LocalToolManifestReader.ReadTools` — complexity 20 → 15
- `csharpsquid:S3776` `LocalToolManifestWriter.LocateVersion` — 20 → 15
- `csharpsquid:S1066` `LocalToolManifestWriter` — merged nested `if`
- `csharpsquid:S3776` `LocalToolManifestWriter.Compare` — 24 → 15
- `csharpsquid:S3776` `ToolchainAnalysis.EvaluateLocalTools` — 20 → 15

### Refactors (no behaviour change, no suppressions)
- `ReadTools` keeps the two `tools` container checks and delegates each entry to `ReadTool`, with
  duplicate-command bookkeeping in `RecordCommands`. Problem strings and their order are unchanged,
  and the tool is still added after its commands are recorded.
- `LocateVersion` delegates container-stack handling to `TryReadContainerToken`/`PopContainer` and
  now has a single `String && IsToolVersion` condition (clears S1066).
- `Compare` dispatches to `CompareObject` / `CompareArray`; the one writable path is checked by
  `IsTargetVersion` + `AssertTargetVersion`. Error paths and messages are byte-identical.
- `EvaluateLocalTools` delegates to `AddInvalidManifestIssue`, `CollectMissingTools` and
  `AddNotRestoredIssue`, preserving issue order and the `LocalToolFindings` null rules.

### Verification
- `dotnet build NugetPackageManager.slnx -c Release` — success, 0 warnings/errors.
- `dotnet test` — 57 + 108 + 225 passed (no test changes needed).
- `npm run quality` — **PASS, 8/8** (525 TS tests).
- Commit `438943d` pushed to `feat/local-dotnet-tools`; SonarCloud re-analysis then reported
  `total: 0` for PR 56 (`sinceLeakPeriod=true`, OPEN/CONFIRMED).
