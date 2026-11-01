# Backlog — finish C# coverage to 100% (line)

Status: NOT STARTED — ready to pick up
Created: 2026-11-01
Owner: whoever picks it up next (safe to split across sessions)

Goal: **100% line coverage of `src/**`** (decided with the user). Branch coverage should rise
where it is cheap, but is not a target. Genuinely unreachable code may carry
`[ExcludeFromCodeCoverage]` with a one-line reason.

SonarCloud stays on **automatic analysis**, which cannot import coverage — the reports are
produced for local use and as a CI artifact only. Do not add a scanner.

## The tooling already exists — do not rebuild it

| Piece | Where |
|---|---|
| coverlet settings (cobertura + opencover, generated code excluded) | `tests/coverlet.runsettings` |
| Run every C# suite with coverage | `npm run test:csharp` → `coverage/csharp/**/coverage.{cobertura,opencover}.xml` |
| Full gate (includes the C# report) | `npm run quality` |
| HTML-ish summary of gaps | see *Measuring* below |

### Measuring

The aggregation script is not checked in (it lived in the session scratch dir). Re-create it or
use `ReportGenerator`:

```bash
# option A — ReportGenerator (best UX)
dotnet tool install -g dotnet-reportgenerator-globaltool
reportgenerator -reports:"coverage/csharp/**/coverage.cobertura.xml" \
  -targetdir:coverage/report -reporttypes:"TextSummary;Html"

# option B — a small python script that merges the cobertura files and prints
#            per-file missed line numbers (what the previous session used)
```

Baseline at the time this plan was written: **2 519 / 2 755 lines = 91.4%** (branch 65.5%),
228 C# tests (85 Core + 42 Core.NuGet + 101 Core.Workspace), gate 8/8 green.

## Rules while writing them

- **MSTest only** — xUnit and NUnit are forbidden in this repo (`.ai/reference/forbidden-tech.md`).
- **Duplication ≤ 3% on new code** (Sonar gate). Use `[DataRow]` tables and small shared
  builders; do not copy-paste a test per branch. Current estimate: 0.17%.
- Package versions go through `Directory.Packages.props`; test projects already reference
  `coverlet.collector`, `MSTest.*`, `Moq`.
- Keep the existing test-project split: a source project's tests live in the matching
  `tests/NugetPackageManager.Core*.Tests` project, mirroring the `src/` layout.
- After each phase: `dotnet test` for the touched project, then re-measure.

## Phase 1 — small gaps, pure functions (≈ 32 lines, low risk)

| File | Missed | What is uncovered / approach |
|---|---|---|
| `Core.Workspace/Dependencies/RequirementClosure.cs` | 1/38 | one guard inside the closure walk; drive it with a range that has no lower bound |
| `Core.Workspace/Dependencies/VersionSemantics.cs` | 3/21 | non-semver strings (`Compare` fallback) and an empty range |
| `Core.NuGet/Configuration/NuGetConfigResolver.cs` | 1/65 | the `clearMappings` branch across two files |
| `Core/ConfigurationHandlers.cs` | 1/44 | `ReadStringArray` with a non-array property |
| `Core/NuGetCoreHandlers.cs` | 1/47 | one parameter-guard |
| `Core.Workspace/Cpm/CpmPropsReader.cs` | 2/146 | `<PackageVersion>` without `Include`/`Version`; the unconditional branch in `UnconditionalAndConditionalResolutions` |
| `Core/WorkspaceHandlers.cs` | 2/56 | `unknown scope` / malformed `changes` |
| `Core/Diagnostics/RestoreOutput.cs` | 5/89 | summary/conflict variants not present in the current fixtures |
| `Core.NuGet/Sources/PackageMapping.cs` | 7/171 | search/registration shapes: missing fields, string-vs-array, empty catalog entry |
| `Core/Protocol/NdjsonServer.cs` | 4/49 | malformed line handling and the cancel-without-id path |

## Phase 2 — CPM internals (≈ 34 lines)

| File | Missed | Approach |
|---|---|---|
| `Core.Workspace/Cpm/CpmCondition.cs` | 19/269 | parser edge cases: unbalanced parens, unknown call, unexpected token at EOF, quoted identifier, `!=`/`==` on properties |
| `Core.Workspace/Cpm/CpmWriter.cs` | 15/203 | verification failures (element count changed, package missing), negated/combined conditions, remove-inside-group |

Golden files already exist under `tests/NugetPackageManager.TestUtilities/Fixtures/cpm`; prefer
adding fixtures over inline XML when the case is realistic.

## Phase 3 — diagnostics and dependency graph (≈ 46 lines)

| File | Missed | Approach |
|---|---|---|
| `Core/Diagnostics/DotnetFailureClassifier.cs` | 20/149 | the kind branches not currently produced: `WorkloadManifestConflict`, `SdkResolutionFailure`, `PinnedSdkMissing`, restore-conflict output |
| `Core.Workspace/Dependencies/AssetsGraph.cs` | 17/139 | assets shapes: missing `targets`, framework mismatch, direct dependency that lowers a version |
| `Core/DependencyHandlers.cs` | 9/123 | handler guards + the closure/order handlers with a stub source |

## Phase 4 — toolchain (≈ 47 lines)

| File | Missed | Approach |
|---|---|---|
| `Core/Toolchain/ToolchainAnalysis.cs` | 24/245 | probe matrix: failing `version` output, pinned SDK missing, orphaned manifest bands, private SDKs, runtime check rows |
| `Core/Toolchain/GlobalJson.cs` | 23/268 | update paths: create from nothing, `tools.dotnet` rewrite, workload-version removal, `allowPrerelease` toggle, canonical rewrite when the patch does not verify |

`GlobalJson` is pure string/JSON work on a temp directory — no process needed. Prefer `[DataRow]`
over one test per scenario.

## Phase 5 — NuGet transport (≈ 70 lines, hardest — do last)

| File | Missed | Approach |
|---|---|---|
| `Core.NuGet/Sources/HttpNuGetSource.cs` | 24/53 | clear-cache paths, page-reference follow, trusted/untrusted page URLs; use the existing `HttpMessageHandler` stub pattern from `PackageLookupFailureTests` |
| `Core.NuGet/Sources/NuGetSourceProvider.cs` | 21/21 (0%) | builds `SourceRepository` from descriptors; may need a seam (or a narrow `[ExcludeFromCodeCoverage]` with justification if it is a pure SDK adapter) |
| `Core.NuGet/Sources/SourceRepositoryFactory.cs` | 10/10 (0%) | same question as above — decide **seam vs exclusion** before writing tests |
| `Core.NuGet/Sources/NuGetHttpClient.cs` | 9/15 | error mapping: non-success status, timeout, malformed JSON |
| `Core.NuGet/Vulnerabilities/NuGetVulnerabilityReader.cs` | 6/6 (0%) | reader over a stubbed source; if it can only talk to a real feed, cover the cache path and exclude the transport call |

Phase 5 is where an exclusion is most likely defensible: these types are thin adapters over
`NuGet.Protocol`. Any exclusion must be `[ExcludeFromCodeCoverage]` **plus** a comment naming
what would be tested with a real feed.

## Phase 6 — leftovers and the entry point (≈ 26 lines)

| File | Missed | Approach |
|---|---|---|
| `Core.Workspace/WorkspaceModelService.cs` | 6/52 | unreadable project / empty framework list |
| `Core.Workspace/TargetFrameworks/TargetFrameworkResolver.cs` | 4/110 | cache eviction at `MaxCacheEntries`; `DotnetHost()` fallback when the process is not the muxer |
| `Core/Program.cs` | 16/16 | **exclude** — top-level entry point that wires handlers and runs the NDJSON server; the server itself is covered |

## Definition of done

1. `npm run test:csharp` reports **0 missed lines** for `src/**` (generated code already excluded).
2. `npm run quality` passes 8/8.
3. Every `[ExcludeFromCodeCoverage]` added has a comment explaining why the code cannot be
   exercised; no blanket assembly-level exclusions.
4. `.ai/progress/csharp-coverage-100.md` is closed out and moved to `.ai/completed/`.

## Notes / risks

- `HttpNuGetSource`, `NuGetSourceProvider`, `SourceRepositoryFactory` and
  `NuGetVulnerabilityReader` sit on `NuGet.Protocol`; cover the logic with stubs and only fall
  back to exclusion where the type is a pure SDK adapter.
- The resolver's msbuild path is exercised by a real `dotnet msbuild` call in
  `TargetFrameworkResolverFallbackTests` (~6 s). Keep that test; it is the only guard on the
  JSON/plain-text parsing that regressed once already.
- Do not touch the TypeScript coverage setup; `coverage/lcov.info` and `coverage/csharp` are
  independent and both are gitignored.
