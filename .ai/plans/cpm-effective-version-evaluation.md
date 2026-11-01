# Plan: effective CPM / package versions via the MSBuild object model

Status: IMPLEMENTED (2026-11-01) — see `.ai/completed/cpm-effective-version-evaluation.md`.
Owner: Reasonix Code
Progress file: `.ai/progress/cpm-effective-version-evaluation.md`

## Problem

`Directory.Packages.props` is parsed as XML (`CpmPropsReader.Parse`), so a version written as a
property reference reaches the model verbatim:

```xml
<PropertyGroup>
  <FooBarVersion>1.2.3</FooBarVersion>
</PropertyGroup>
<ItemGroup>
  <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
</ItemGroup>
```

The Installed/Updates/Consolidate/Vulnerabilities tabs then show `$(FooBarVersion)` as the
installed version, and Updates reports `$(FooBarVersion) != 1.4.0`. The same happens to
`<PackageReference Version="$(...)" />` in non-CPM projects.

## Verified facts (probed in `$TMPDIR` with the installed SDK 11.0.100-rc.3)

`dotnet msbuild <project> -getItem:PackageVersion -getProperty:TargetFramework -nologo` returns
JSON with fully evaluated `Version` metadata, including property expansion:

```json
{ "Properties": { "TargetFramework": "" },
  "Items": { "PackageVersion": [ { "Identity": "Foo.Bar", "Version": "1.2.3",
    "DefiningProjectFullPath": ".../Directory.Packages.props", ... } ] } }
```

- `-p:TargetFramework=net8.0` evaluates conditional `ItemGroup`/element conditions for that
  framework (verified: a `net8.0`-only entry appears for `net8.0`, disappears for `net9.0`).
- No restore is required.
- `dotnet msbuild <project> -pp:<temp>` writes the project with every import expanded and each
  import wrapped in a boundary comment that names the imported **file path**, including nested
  imports. Property definitions therefore map back to their real source file. Imports whose
  conditions are false are commented out. `-pp` needs no restore either.
- `MSBuildAllProjects` is **not** reliable for this (it listed only `Directory.Build.props` and
  omitted `Directory.Packages.props`).

## Decisions taken (user)

1. **Write behaviour: always update the property** — even when several package entries share it.
2. **Write scope: C — every file MSBuild imports.** If a property is defined in
   `Directory.Build.props`, an imported `.props`/`.targets`, or the project file, that is the file
   that gets edited. Snapshot/rollback is extended to cover it.
3. **Scope: CPM props and project `PackageReference`.** Both read paths get effective values.
4. **Per-TFM guard:** a group-scoped (single-TFM) update writes a literal into that condition's
   `PackageVersion` line; it never bumps a shared unconditional property and silently changes the
   other frameworks.
5. **Failure behaviour: silent fallback.** Any MSBuild failure → today's raw XML value; no new
   error surface.

## Read half

### New C# types (`src/NugetPackageManager.Core.Workspace/Cpm/`)

| File | Type | Purpose |
|---|---|---|
| `ICpmEvaluator.cs` | `ICpmEvaluator` | `Task<CpmEvaluation?> EvaluateAsync(projectPath, targetFramework?, ct)`; `null` = unavailable/failed |
| `CpmEvaluation.cs` | `CpmEvaluation` | `CentralVersions` (id → effective `PackageVersion` version) and `PackageReferences` (id → effective `PackageReference` version) |
| `CpmEvaluator.cs` | `CpmEvaluator` | Default implementation: spawns `dotnet msbuild` through the same host resolution as `TargetFrameworkResolver`, 60 s timeout, 16-slot semaphore, 500-entry cache keyed on project/props/`Directory.Build.props` stamps |
| `PropertyReference.cs` | `PropertyReference` | Parses a whole-value `$(Name)` reference for the write half |

`CpmEvaluator` exposes an internal static `ParseEvaluation(string json)` so the JSON shape is unit
tested without spawning a process.

### `WorkspaceModelService` wiring

1. Parse the map as today.
2. Detect property expressions: any central version, or (non-CPM) any project `PackageReference`
   `Version`/`VersionOverride`, containing `$(`.
3. None → exactly today's code path (no process spawn, no behaviour change).
4. Some:
   - One evaluation with no `TargetFramework` supplies the flat map used by
     `ProjectFileReader.Read`.
   - With conditional groups: resolve TFMs as today and run one evaluation per TFM; pass
     `tfm → id → effective version` so every `CpmVersionResolution.Version` uses the evaluated
     value while the XML still supplies condition/label/order.
   - Non-CPM: re-read with the evaluated `PackageReference` map; only entries whose raw value
     contained `$(` are replaced.
   - A package missing from an evaluation falls back to the raw XML value for that row; a failed
     evaluation leaves the whole project on raw values.

`CpmPropsReader.ResolveVersions` gains an optional
`IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? effectiveVersionsByTfm`
parameter (default `null` = current behaviour). `ProjectFileReader.Read` gains an optional
`IReadOnlyDictionary<string, string>? evaluatedVersions` parameter.

### Contract impact (read)

None. `getProjects` keeps its JSON shape; only values change. `getCpmMap` stays raw because the
host uses it for identity/conditions and the writer needs the original `$(...)` text.

## Write half

### Locating the property definition

New types in `src/NugetPackageManager.Core.Workspace/Cpm/`:

| File | Type | Purpose |
|---|---|---|
| `PropertyDefinition.cs` | `PropertyDefinition` | `FilePath`, `PropertyName`, `Value` of one unconditional definition |
| `ICpmPropertyLocator.cs` | `ICpmPropertyLocator` | `Task<PropertyDefinition?> LocateAsync(projectPath, propertyName, ct)` |
| `CpmPropertyLocator.cs` | `CpmPropertyLocator` | Runs `dotnet msbuild <project> -pp:<temp>`, parses the boundary comments and returns the **last** unconditional definition; `null` when none |

Parser rules (unit-tested without spawning):

- Walk the preprocessed document in order, maintaining a stack of imported file paths from the
  import boundary comments; elements outside an import belong to the project file.
- Only `<PropertyName>` elements inside a `<PropertyGroup>` count.
- Skip a definition when the element, its `PropertyGroup`, or any ancestor below the root
  `Project` carries a `Condition` (conditional definitions are not safely editable).
- Skip definitions inside a `<Target>`.
- The last remaining definition wins (MSBuild assignment order). Its raw value may reference other
  properties; it is replaced with the literal version.
- Cache per project + file stamps; bounded at 500 entries.

### `CpmWriter` rules

For each `CpmVersionChange`:

1. Locate the addressed `PackageVersion` line(s) with today's scope rules
   (`Group` / `Unconditional` / `All` / `First`).
2. **Property path** only when all of the following hold:
   - the change is not group-scoped (per-TFM guard),
   - every addressed occurrence is in an unconditional `ItemGroup`,
   - the occurrence's raw `Version` is exactly `$(Name)`,
   - `CpmPropertyLocator` finds an unconditional definition in a file inside a supplied workspace
     root,
   - all project paths supplied for this props file resolve `Name` to the same defining file.
3. Then rewrite that property's text value in its own file (single read/verify/write per file).
4. Otherwise use the existing literal replacement on the `PackageVersion` line.

Verification:

- Property path: the property text became the new version, the `PackageVersion` `Version`
  attribute still reads `$(Name)`, element counts are unchanged.
- Literal path: unchanged golden-file behaviour.
- Multiple files are read, verified and written in one pass; a write failure leaves the host
  snapshot to restore every file.

### RPC / host changes

- `updateCpmVersions` request gains `projectPaths: string[]` and `workspaceRoots: string[]`;
  response gains `changedFiles: string[]`.
- `updatePackageVersion` request gains `workspaceRoots: string[]`.
- New read-only method `resolveCpmWriteTargets`
  (`{ propsFilePath, projectPaths, changes, workspaceRoots }` → `{ files: string[] }`) so the
  host can snapshot the property files **before** the first write. It runs the same resolution and
  returns only files the writer would modify.
- Host snapshot sets are extended:
  - batch: build the CPM write plan once before snapshotting, call `resolveCpmWriteTargets` per
    props file, add the results to `collectBatchFilesAsync`'s set;
  - single project update: same call inside `snapshotProjectUpdateAsync`;
  - `updateCentralVersionsAsync`: snapshot `propsFile` **plus** the resolved property files, and
    restore all of them when its post-write restore fails (today it restores only `propsFile`).
- `fixRestoreConflictAsync` / `applyConflictFixesAsync` pass `workspaceRoots`; they have no
  rollback today and keep that behaviour.
- `cpm-conditional.ts` stays literal-only; the per-TFM guard means it never needs property logic.
  Unconditional changes still route through `CpmWriter`.

### Security

Every defining file must resolve inside one of the supplied workspace roots before it is edited;
otherwise the writer falls back to a literal. The `-pp` temp file is created in the system temp
directory, never in the workspace, and deleted in `finally`.

## Tests

Every scenario below gets an automated test; this is the acceptance matrix.

| # | Scenario | Level |
|---|---|---|
| 1 | `Version="$(FooBar)"` in an unconditional props group → effective `Version` in the model, no false Updates difference | core + E2E |
| 2 | Property value with prefix/suffix | core |
| 3 | Conditional groups using properties → one `CpmResolutions` row per TFM with the MSBuild value and existing condition label | core |
| 4 | Package with multiple `CpmResolutions` and an empty flat `Version` is not skipped (mandatory multi-TFM regression) | core + host |
| 5 | Evaluation fails / returns `null` → raw `$(...)` retained, scan continues | core |
| 6 | No `$(` anywhere → evaluator never invoked (cost guard) | core |
| 7 | Non-CPM `PackageReference Version="$(...)"` → effective value; literal siblings untouched | core |
| 8 | Update of `$(Name)` → property definition edited, `Version="$(Name)"` left in place | core |
| 9 | Property shared by two `PackageVersion` entries → both see the new value | core |
| 10 | Definition in `Directory.Build.props` / an imported `.props` / the project file → that file is edited | core |
| 11 | Definition outside the workspace roots → literal fallback | core |
| 12 | Conditional property definition, no definition, or embedded `1.$(Minor)` → literal fallback (goldens unchanged) | core |
| 13 | Group-scoped (per-TFM) update of a `$(Name)` line → literal in that condition, property untouched | core |
| 14 | Two projects disagree on the property definition → literal fallback | core |
| 15 | Preprocessed-project parser: nested imports, boundary stack, conditional definitions, target-scoped definitions | core (fixture) |
| 16 | Host snapshots include the property file returned by `resolveCpmWriteTargets`; failed restore rolls it back | host |
| 17 | Real sidecar + real `dotnet`: `Directory.Build.props` variable resolves in `getProjects`, update edits that file, props file unchanged | E2E (opt-in) |

## Documentation

- `README.md` — CPM section: property-based versions are evaluated with MSBuild and updates keep
  the variable wherever it is defined.
- `CHANGELOG.md` — one entry under `## Unreleased`.

## Files expected to change

```text
src/NugetPackageManager.Core.Workspace/Cpm/ICpmEvaluator.cs              (new)
src/NugetPackageManager.Core.Workspace/Cpm/CpmEvaluation.cs              (new)
src/NugetPackageManager.Core.Workspace/Cpm/CpmEvaluator.cs               (new)
src/NugetPackageManager.Core.Workspace/Cpm/PropertyReference.cs          (new)
src/NugetPackageManager.Core.Workspace/Cpm/PropertyDefinition.cs         (new)
src/NugetPackageManager.Core.Workspace/Cpm/ICpmPropertyLocator.cs        (new)
src/NugetPackageManager.Core.Workspace/Cpm/CpmPropertyLocator.cs         (new)
src/NugetPackageManager.Core.Workspace/Cpm/CpmPropsReader.cs             (resolution override)
src/NugetPackageManager.Core.Workspace/Cpm/CpmWriter.cs                  (property update + targets)
src/NugetPackageManager.Core.Workspace/WorkspaceModelService.cs          (wiring + cache)
src/NugetPackageManager.Core.Workspace/Projects/ProjectFileReader.cs     (optional evaluated map)
src/NugetPackageManager.Core/WorkspaceHandlers.cs                        (new params + RPC)
src/NugetPackageManager.VSCode.Host/utilities/cpm-writer.ts              (params + resolve targets)
src/NugetPackageManager.VSCode.Host/host-api.ts                          (snapshot/revert extension)
tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmEvaluatorTests.cs  (new)
tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmPropertyLocatorTests.cs (new)
tests/NugetPackageManager.Core.Workspace.Tests/WorkspaceModelServiceTests.cs
tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmWriterTests.cs
tests/NugetPackageManager.Core.Workspace.Tests/Projects/ProjectFileReaderTests.cs
tests/NugetPackageManager.TestUtilities/Fixtures/cpm/property-versions.props        (new)
tests/NugetPackageManager.TestUtilities/Fixtures/cpm/expected/property-versions.*.props (new)
tests/NugetPackageManager.TestUtilities/Fixtures/msbuild/preprocessed-project.xml   (new)
tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Host/host-api.test.ts
tests/NugetPackageManager.VSCode.Tests/e2e/dotnet-roundtrip.e2e.ts
README.md, CHANGELOG.md
```

## Verification

```bash
dotnet build NugetPackageManager.slnx -c Release
dotnet test  NugetPackageManager.slnx -c Release
npm run typecheck
npm run lint
npm test
npm run quality
```

Plus a manual probe against a fixture with `dist/core` (`getProjects`, `resolveCpmWriteTargets`,
`updatePackageVersion`) and `npm run test:e2e` where the environment allows it.

## Risks / non-goals

- **Cost:** reads add one `dotnet msbuild -getItem` per project with variables (plus one per TFM
  when conditional groups exist); writes add one `-pp` per addressed project. All cached and
  bounded, and skipped entirely when no `$(` is present.
- **Disagreement between MSBuild and the XML condition evaluator** for the same TFM: MSBuild
  supplies the version, the XML supplies the label; at worst a label is surprising, the version is
  right.
- **Shared property edits** are intentional (user decision) and can change several packages at
  once; the per-TFM guard prevents accidental cross-framework bumps.
- **Non-goals:** property-based `VersionOverride`; definitions inside `<Target>`; conditional
  property definitions; nested/embedded expressions on write (all fall back to a literal).
