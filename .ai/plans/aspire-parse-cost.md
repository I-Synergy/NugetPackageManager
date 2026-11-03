# Why 522 aspire projects take ~12 minutes, and what to do about it

Status: APPROVED (2026-11-03, measured on the local aspire checkout)
Started: 2026-11-03

## Measurements (local aspire checkout, this machine)

| Fact | Value |
|---|---|
| `.csproj` files | 522 (74 multi-target, 424 single-target) |
| One `dotnet msbuild -getItem:PackageVersion -getItem:PackageReference -getProperty:TargetFramework` | **6.6 s** (6.7 s on the first run — no node reuse to warm up) |
| Core `getProjects` for 30 projects | **40.5 s** → ~1.35 s/project with 16-way parsing |
| Extrapolated for 522 | **~700 s (12 min)** |
| `Directory.Packages.props` | 89 `Version="$(…)"` references, 9 conditional groups, one `<Import Project="eng/Versions.props">` |
| Restored projects | 494, but under Arcade's `artifacts/obj/<name>/project.assets.json`, **not** `obj/project.assets.json` |

Cause: `CpmPropsReader` sees `$(` in the CPM map, so `ParseCpmProjectAsync` runs
`cpmEvaluator.EvaluateAsync(project, null)` for **every** project, and because the map has
conditional groups it runs one more evaluation **per target framework** (two for the multi-target
projects). That is ~3.3 evaluations per project ≈ 1 700 spawns × 6.6 s ÷ 16 slots ≈ 12 minutes.
The XML reading itself is milliseconds; the whole cost is `dotnet msbuild` process startup plus
MSBuild evaluation of Aspire's Arcade import tree.

The webview's 120 s `RPC_TIMEOUT_MS` therefore fires at ~10 % progress: "Failed to check for
updates — RPC timeout after 120000ms (the operation is still running in the extension host)".

## Fix

### Phase A — resolve CPM property versions without MSBuild (C#)

New `src/NugetPackageManager.Core.Workspace/Cpm/CpmPropertyResolver.cs`:

- For a `Directory.Packages.props`, follow its `<Import Project="…">` elements (relative to the
  importing file, visited set) and collect `<PropertyGroup><Name>value</Name>` literals.
- Substitute a `<PackageVersion Version="$(Name)" />` (and a conditional entry's version) **only**
  when the whole value is a single `$(Name)` and `Name` has exactly one literal definition across
  the chain.
- If every property reference in the map resolves, the map is **complete** and is returned with
  the references replaced; if anything is unresolved, ambiguous (defined twice with different
  values) or uses a function/expression, return `null` and keep today's MSBuild path.
- Cache per props file with the same stamp idea as `CpmEvaluator` (props file + imported files +
  `Directory.Build.props`).
- Wire into `WorkspaceModelService.LoadCpmMap`: a resolved map means
  `HasPropertyReferences(map)` is false, so neither the unconditional nor the per-TFM evaluation
  runs for projects whose versions are literals after substitution.

Aspire's chain is the easy case: the values are literals that live in `eng/Versions.props`.

### Phase A2 — partial resolution + per-project decision (measured follow-up)

The first cut made the resolver all-or-nothing: one unresolved reference in
`Directory.Packages.props` (aspire references `$(MicrosoftSignedWixVersion)`, which no props file
in the repo defines) returned `null` for the whole map, so every project kept the MSBuild path —
the 30-project replay stayed at 45 s instead of dropping.

Change the contract:

- `CpmPropertyResolver.TryResolve` substitutes every entry it can and **leaves the rest as
  written**; it only returns `null` when the props file itself cannot be read/parsed.
- `WorkspaceModelService.ParseCpmProjectAsync` decides per project: it reads the project's own
  package ids first (a cheap XML read), and only runs the unconditional/per-TFM evaluation when
  one of *this project's* referenced ids still has a `$(…)` version in the (possibly partial) map
  — or when the project's own `PackageReference` version is an expression.
- A conditional entry that does not resolve keeps today's per-TFM path for projects that use it.

Expected: aspire resolves 82 of 83 property names; only the few projects referencing
`Microsoft.Signed.Wix` still evaluate. Everything else parses in milliseconds.

### Phase B — find Arcade's assets file (C#)

`TargetFrameworkResolver.TryResolveFromAssets` only looks at `<projectDir>/obj/project.assets.json`.
Arcade puts it at `<repo>/artifacts/obj/<ProjectName>/project.assets.json`, so 74 multi-target
projects fall through to MSBuild. Add an ancestor search (bounded, e.g. 8 levels) for
`artifacts/obj/<projectNameWithoutExtension>/project.assets.json`, keeping the existing staleness
check. This removes the remaining per-project TFM evaluation.

### Phase C — the outdated scan stops paying the 120 s cliff (TypeScript)

Even when fast, a scan must never be reported as a failure because a client gave up:

- `startOutdatedScanAsync(req) -> { JobId }`, kind `"outdatedScan"` in `OperationJobs`, the runner
  wrapping `outdatedScans.RunAsync(...)` (single-flight and memo unchanged).
- `updates-view` and `packages-view` use a `runOutdatedScanJobAsync` helper (poll `getJobAsync`,
  progress into the existing scan banner) instead of the direct call.
- `getOutdatedPackagesAsync` stays on `HostAPI` for compatibility.

### Phase D — fewer `dotnet` processes

The gate is 16 slots per extension host. With Phase A/B the spawn count collapses; additionally
lower the default `MsBuildProcessGate` capacity to `Math.Clamp(ProcessorCount, 2, 8)` so a slow
repo cannot flood the machine with `dotnet msbuild` children while evaluations remain.

## Tests

- C#: resolver unit tests (literal chain, import chain, ambiguous property → null, missing
  property → null, function syntax → null, cache invalidation on props change); assets lookup in
  an Arcade-shaped fixture.
- TS: `outdatedScan` job round-trip; updates-view/packages-view use the job; existing scan tests
  keep passing.
- End-to-end measurement on aspire: `getProjects` for all 522 projects must finish in a few
  seconds, and the Updates scan must complete through the job.

## Verification

`npm run quality`, replay the 522-project `getProjects` against the real sidecar and record the
elapsed time, then build a test VSIX.
