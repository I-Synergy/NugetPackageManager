# Plan: move host logic from TypeScript to C#

**Status:** COMPLETE — Waves A–F landed
**Branch:** `spike/blazor-wasm-webview`
**Date:** 2026-11-01
**Predecessor:** `.ai/plans/nuget-core-sidecar-slice.md`

## What this can and cannot be

The extension host cannot be replaced: VS Code loads a Node module and there is no .NET
binding for the extension API. So "move as much as possible" means moving **logic** into the
existing C# sidecar and leaving the host as a thin adapter.

Measured on the current tree: 30 non-test host modules; only **8 import `vscode`**. The other
22 are pure Node/TypeScript logic — XML parsing, version semantics, CPM resolution, NuGet
HTTP, restore-diagnostics parsing, toolchain probing — and a .NET process can do all of it.

## Boundary rules (these decide whether the move pays off)

1. **One RPC per user-level operation**, never per helper. `getPackages`, `getProjects`,
   `startConsolidate` — not `compareVersions` or `evaluateCondition`.
2. **The DTOs do not change.** `src/NugetPackageManager.VSCode.Common/types.d.ts` stays the
   contract for the webview; the sidecar emits exactly those shapes.
3. **The host keeps what only the host can do**: activation, webview, commands, TreeView,
   status bar, editor decorations, workspace trust, `workspaceState`, and reading VS Code
   settings (proxy included — it is passed into the sidecar, not read there).
4. **Every wave ships behind the flag** (`nugetpackagemanager.useCore`, default off) until its
   parity harness passes, then the TypeScript implementation is deleted in the same PR.

## Module inventory

| Wave | Modules | Lines | Stays TS because |
|---|---|---|---|
| **A — done** | transport (`NdjsonServer`), core client, advisories | — | — |
| **B — done** | `nuget/api.ts`, `nuget/http-cache.ts`, `nuget/source-api.ts`; `local-feed.ts` remains | 568 + 103 + 56 = **727** | local `.nupkg` reading |
| **C — done** | `utilities/project-parser.ts`, `project-framework-resolver.ts`, `cpm-resolver.ts`, `cpm-condition.ts` | 109 + 366 + 933 + 470 = **1,878** | — |
| **D — done** | `utilities/dependency-graph.ts`, `requirement-closure.ts` | 242 + 220 = **462** | `version.ts` (see Wave D) |
| **E — done** | `utilities/restore-diagnostics.ts`, `dotnet-failure.ts` | 182 + 273 = **455** | `dotnet-context.ts` (see Wave E) |
| **F — done** | `utilities/global-json.ts`, `toolchain-health.ts`, `sdk-check.ts` (parsing/detection) | 298 + 187 + 96 = **581** | invocation/path plumbing: `sdk-install.ts`, `workload-commands.ts`, `sdk-locations.ts`, `dotnet-context.ts` |
| — | `extension.ts`, `host-api.ts` (shrinks to delegation), `package-version-decorator.ts`, `password-script-executor.ts`, `scan-cache.ts`, `status-bar-utils.ts`, `operation-jobs.ts`, `task-executor.ts`, `nuget/api-factory.ts` | ~5,600 | `vscode` API, trust boundary, cancellation, progress streaming |

Total that can move: **≈ 5,775 lines**, plus roughly half of `host-api.ts` dissolving into
delegation as the waves land.

## Waves

### Wave B — NuGet source metadata (DONE)

Landed in C#: `getPackages`, `getPackage`, `getPackageDetails`, `getVulnerabilities`, plus
`clearPackageCache` / `clearVulnerabilityCache`. The TypeScript client (`nuget/api.ts`, 568
lines) and its suite (848 lines) are deleted; `nuget/api-factory.ts` now builds
`SidecarSourceApi` and `nuget/core-process.ts` owns the process (configured at activation,
disposed at deactivation, `dotnet` launched from `dist/core`).

Behaviour preserved rather than assumed: the 5-minute package cache and 1-hour advisory cache
live in the C# core now, credentials are attached per request only for the source host and the
hosts its service index declares, the proxy is read from VS Code and passed in, and
`registration5-gz-*` responses are decompressed (`AutomaticDecompression`). Folder-based
sources still run through `local-feed.ts` — the one deliberate TypeScript remainder in this
wave.

Verification: `dotnet test` 34/34, `npm run quality` PASS, `npm test` 503 passing (535 minus
the 32 tests that belonged to the deleted suite), and live calls against nuget.org for all four
methods.


`searchAsync`, `getPackageAsync`, `getPackageDetailsAsync` against a source descriptor, with
the proxy passed in and the same error codes. Advisories are already done.

Parity risk found in step 4: the DTO leaks registration leaf URLs (`Package.Id`,
`Versions[].Id`, `Package.Registration`) and `Verified`, which `NuGet.Protocol` does not
expose. Resolution: port the registration/search JSON reading directly (it is what the
TypeScript does today) instead of routing through `PackageSearchResourceV3`, and keep
`NuGet.Protocol` for advisories where it is an exact fit.

### Wave C — project model read path (DONE and wired)

The whole read path is ported, wired and verified. In the `Core.Workspace` project:

| Piece | Replaces | Tests |
|---|---|---|
| `Cpm/CpmCondition.cs` — tokenizer, parser, tri-state evaluator, labels, TFM major | `cpm-condition.ts` (470 lines) | 16 |
| `Cpm/CpmPropsReader.cs` — props parsing, conditional scoping, last-match-wins, per-TFM resolution | `cpm-resolver.ts` read path | 15 |
| `Projects/ProjectFileReader.cs` — `PackageReference`, versions, `VersionOverride`, CPM precedence, pinned ranges | `project-parser.ts` (109 lines) | 9 |
| `TargetFrameworks/TargetFrameworkResolver.cs` — literal XML → assets → `dotnet msbuild` → XML fallback, caching | `project-framework-resolver.ts` (366 lines) | 9 |
| `WorkspaceModelService.cs` — CPM lookup, flat map, resolutions, sorting | `parseProjectWithCpmAsync` in `host-api.ts` | 6 |
| `Models/ProjectModels.cs` — the `Project`/`ProjectPackage`/`CpmResolution` wire shapes | `types.d.ts` (unchanged) | — |

**Wiring:** `getProjectsAsync` sends the discovered project paths to the core and returns its
model. Discovery deliberately stays in TypeScript — workspace globbing, solution restriction and
the exclude settings are VS Code concerns, and reimplementing them in the core would drift. If the
core is absent or fails, the host logs and falls back to the in-process path.

**C2 part 1 — the TypeScript parsers are gone.** Every call site now goes through one
`parseProjectsAsync` helper that calls the core's `getProjects`, so
`project-parser.ts` (109 lines) and `project-framework-resolver.ts` (366 lines) are deleted,
along with their 367 lines of tests. What changed in behaviour:

- `getProjectsAsync` has no in-process fallback any more: a core failure is a reported error,
  not a silent second implementation.
- The updates scan parses in batches of ~10 so the progress bar still moves; one round trip per
  batch instead of one process-free parse per project.
- `collectUsedPackagesAsync` refuses to answer when the core skips a project, preserving the
  "never delete a used package" rule the per-project try/catch used to provide.
- The per-TFM fixture assertions moved to `Core.Workspace.Tests`, where the resolution logic now
  lives; they run the same `negated-positive.props` and `projects/*` fixtures.

**C2 part 2 — the CPM writer is ported and on the request path.** `CpmWriter`
(`Core.Workspace/Cpm`) implements `UpdateVersionsAsync`, `RemovePackageVersionAsync` and
`UpdatePackageVersionAsync`, exposed as `updateCpmVersions`, `removePackageVersion` and
`updatePackageVersion`. The host reaches them through `utilities/cpm-writer.ts`, and all eight
call sites — batch updates, single updates, consolidation, cleanup and the restore-conflict fix —
go through it. **No TypeScript code writes `Directory.Packages.props` any more.**

It was written against a parity harness rather than by inspection: six golden files in
`tests/__fixtures__/cpm/expected/` were generated by running the *TypeScript* implementation over
the existing fixtures (first / group / unconditional / all scopes, a negated condition, and a
removal), and the C# tests compare byte for byte. That matters because the writer edits text
surgically — only the addressed `PackageVersion` tag — so any reformat would be a visible
regression in the user's file. The port keeps the same guarantees: validate, apply every change in
memory, verify occurrence counts and per-occurrence versions, refuse to overwrite a file that
changed while the update was prepared, and swap through a temporary file.

The golden files immediately caught one bug the port would otherwise have shipped: the version
attribute regex captured the quoted value instead of the `Version =` prefix, so the first
replacement emitted a malformed tag.

**C2 part 3 — the CPM read path is ported, so C2 is closed.** `CpmPropsReader` was already
exposed as `getCpmMap`; `utilities/cpm-reader.ts` is the thin host adapter (mirroring
`cpm-writer.ts`) that walks to the nearest `Directory.Packages.props`, keeps the
`ManagePackageVersionsCentrally` opt-out check, and turns the wire shape back into `Map`s.
`getTfmMajorVersion` is now a three-line helper in `host-api.ts`. All read call sites — batch
scope, consolidation, project updates, cleanup, conflict preflight/repair, `updateCentralVersions`
— go through `CpmReader`, and `cpm-resolver.ts` (933 lines), `cpm-condition.ts` (470 lines) and
their tests are deleted. The only remaining behaviour not delegated to the core is the directory
walk and the opt-out check, which are workspace file look-ups rather than parsing.

**Test seam.** `host-api.test.ts` no longer bridges the core's write methods to a TypeScript
writer. Its core stub records the request (`updateCpmVersions`, `updatePackageVersion`,
`removePackageVersion`) and the orchestration tests assert on that call — scope, condition,
target file and ordering — while the writing itself is pinned by the core's golden files. Where a
test is about rollback, it installs a test-local `stubCoreCall` that simulates the write so the
restore failure still has something to undo. CPM reads in those tests are answered by an explicit
fixture map (`FIXTURE_MAPS`) instead of a second parser.

`utilities/cpm-reader.test.ts` covers the new adapter seams (directory walk, opt-out check,
wire→`Map` conversion, membership helpers); condition evaluation, last-match-wins and per-TFM
resolution remain pinned by `Core.Workspace.Tests`.

Two porting notes worth keeping. `System.Text.Json` and the compiler are stricter than the
TypeScript: `switch` expressions over enums need a `_` arm (CS8524) while the style analyzer
wants every arm spelled out (IDE0072), so exhaustive switches became `if` chains. And the
repository's `.editorconfig` names private and static-readonly fields in camelCase, which is why
the ported code differs from the class template in `.ai/reference/templates/`.

### Wave D — dependency semantics (DONE)

`NuGet.Versioning` and `NuGet.Frameworks` now own the version and framework rules for the
dependency operations. In `Core.Workspace/Dependencies`:

| Piece | Replaces | Tests |
|---|---|---|
| `AssetsGraph.cs` — assets reading, direct references, redundant/pinned analysis | `dependency-graph.ts` (242 lines) | 10 |
| `RequirementClosure.cs` — closure walk, per-TFM conflicts, apply order | `requirement-closure.ts` (220 lines) | 9 |
| `VersionSemantics.cs` (internal) — `NuGetVersion` ordering, `VersionRange` bounds/matching | the comparator inside those modules | 4 |

New handlers (`DependencyHandlers`): `analyzeProjectDependencies`,
`getRestoredDirectDependencies`, `computeRequirementClosure`, `orderRequirements`. The closure
handler fetches dependency metadata from the configured sources itself (same source-order and
exact-version match as before, with the proxy passed in), and TFM group selection uses
`NuGetFramework` (exact group first, then the same `net` major line). The preflight converts
`IsConstrained` into per-TFM id sets plus a `constrainAll` flag; `OrderRequirements` stays one
RPC per preflight, not one per comparison.

**`version.ts` deliberately stays in TypeScript.** Principle 1 of this plan forbids porting
primitives: `compareVersions`, `isVersionInRange` and `satisfiesVersionRange` are used inside
host-side loops (the outdated scan, vulnerability matching, dependency constraints) and sort
comparators, and in `local-feed.ts` (Wave B remainder) and the toolchain modules (Wave F).
Replacing them would mean moving those whole operations — a much larger change than this wave.
They move when their last consumer does; no second dependency algorithm remains in C#.

Verification: `dotnet test` 134/134 (89 workspace, 31 core, 14 NuGet) and the remaining
TypeScript suite passes; `npm run typecheck`, `npm run lint` and `npm run esbuild` clean. The 15
deleted TypeScript cases are covered by the new C# suites.

### Wave E — diagnostics (DONE)

The sidecar now classifies captured `dotnet` output; the host still spawns the process and
streams progress. In `Core/Diagnostics`:

| Piece | Replaces | Tests |
|---|---|---|
| `RestoreOutput.cs` — NU1107/NU1605/NU1109/NU1608/NU1102 parsing, chains, formatting, summary | `restore-diagnostics.ts` (182 lines) | 10 |
| `DotnetFailureClassifier.cs` — kind, summary, hint, detail, pinned/missing SDK, audit, source and credential causes | `dotnet-failure.ts` (273 lines) | 6 |

New handler: `classifyDotnetFailure` (output + project path, pinned SDK and `global.json` path
supplied by the host). `utilities/dotnet-failure.ts` is now a thin adapter
(`ClassifyDotnetFailureAsync`) and `TaskExecutor` awaits it after the child settles; a core
failure degrades to `Unknown` rather than replacing the real error. The host maps the wire shape
directly (`ToFailureInfo` disappeared), and restore attribution reads `Conflicts[].Chains`.

**`dotnet-context.ts` stays in TypeScript.** It resolves the spawn working directory and the
`dotnet` host synchronously, before every `dotnet` invocation, and it selects the extension's
private install (`sdk-locations`, Wave F). Moving it would either put an RPC in front of every
spawn or duplicate the private-install lookup. The classifier receives its two facts
(`PinnedSdkVersion`, `GlobalJsonPath`) from the host context instead of parsing `global.json`
again.

Verification: `dotnet test` 150/150 (89 workspace, 47 core, 14 NuGet), `npm test` 395 passing,
`npm run typecheck`, `npm run lint` and `npm run esbuild` clean.

### Wave F — toolchain (DONE)

The host still spawns every `dotnet` command (progress, cancellation, the private install); the
core receives the captured output and returns findings, and it owns the `global.json` write. In
`Core/Toolchain`:

| Piece | Replaces | Tests |
|---|---|---|
| `GlobalJson.cs` — comment/BOM-tolerant parse, validation, feature band, coherent surgical edit with canonical fallback | the edit path of `global-json.ts` (428 lines) | 10 |
| `ToolchainAnalysis.cs` — `--list-sdks` merge, pin satisfaction, MSBuild property, `sdk check` tables, orphaned manifest bands, the whole `ToolchainHealth` decision | parsing in `toolchain-health.ts` (482) + `sdk-check.ts` (131) | 13 |

New handlers: `updateGlobalJsonSdkVersion`, `evaluateToolchain`. `global-json.ts`,
`toolchain-health.ts` and `sdk-check.ts` are now host adapters: template creation, process
spawning, the `sdk check` cache and the clipboard diagnostics report. Parsing helpers
(`SdkSatisfiesPin`, `ParseSdkList`, `MergeInstalledSdks`, `ParseMsBuildProperty`,
`ParseSdkCheckOutput`, `FindSdkStatus`, `DetectOrphanedManifestBands`) are deleted from
TypeScript and pinned by the C# suites.

**What stays in TypeScript by design.** `sdk-locations.ts` (which host to spawn, private install
lookup — synchronous, before every spawn), `sdk-install.ts` (downloads and runs Microsoft's
install script — the trust boundary), `workload-commands.ts` and `dotnet-context.ts` (spawn
context). `RedactDiagnostics` stays with the report formatter because it is a presentation
concern applied to host-side diagnostics text.

Verification: `dotnet test` 172/172 (89 workspace, 69 core, 14 NuGet), TypeScript suite passing,
`npm run typecheck`, `npm run lint` and `npm run esbuild` clean.

## Final state

All six waves landed. The sidecar owns the NuGet source client, the project/CPM model, the
dependency operations, `dotnet` failure classification, toolchain detection and the
`global.json` write. The host keeps what only it can do (activation, `vscode` state, spawning,
progress, cancellation, trust boundary) plus a small set of deliberate primitives:
`version.ts`, `dotnet-context.ts`, `sdk-locations.ts`, `sdk-install.ts`,
`workload-commands.ts`, `local-feed.ts` and the clipboard diagnostics report. The core adapters
are `cpm-reader.ts`, `cpm-writer.ts`, `dotnet-failure.ts` and `global-json.ts`.

Verification: `npm run quality` PASS (8/8: build, lint, typecheck, tests, C# build, C# tests,
audit), `dotnet test` 172/172, `npm test` 374 passing.

## Test data

The MSBuild fixtures (`__fixtures__/cpm`, `__fixtures__/projects`) now live under
`tests/__fixtures__/`. They are test data consumed by both suites — the TypeScript tests through
`repositoryPath()` and the C# tests through a repository-root walk — so they sit beside the tests
rather than inside the host project. `tests/__fixtures__/Directory.Packages.props` sets
`ManagePackageVersionsCentrally=false` so a fixture never silently inherits the repository's own
central package versions; both props files also skip `__fixtures__` paths.

## Sequencing rule

Each wave: implement in C# → MSTest unit tests + parity fixture → wire behind the flag →
run `npm run quality` + `dotnet test` → delete the TypeScript twin → update this file.
No wave starts before the previous one's TypeScript twin is deleted.
