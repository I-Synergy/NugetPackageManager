# Framework-compatible update candidates

Status: APPROVED (2026-11-10)
Started: 2026-11-10
Progress: `.ai/progress/framework-compatible-updates.md`

## Problem

The Updates scan offers versions that the row's project cannot consume. Reported case: a
`net10.0` row of `CommunityToolkit.Maui.MediaElement` installed `11.0.0` is offered `12.0.0`,
but `12.0.0` declares only `net11.0*` target frameworks — a restore would fail with NU1202.

Root causes:

1. `selectAvailableVersions` (`src/NugetPackageManager.VSCode.Host/host-api.ts:2310`) filters
   by version number only. Nothing asks whether the candidate version supports the row's TFM.
2. The framework-lane guard applies only to packages matching `frameworkAlignedPackages`
   (`Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`, `Microsoft.EntityFrameworkCore.*`,
   `Microsoft.Maui.*`, `System.*`). `CommunityToolkit.Maui.*` is not covered, so no guard runs.
3. `applyLaneCap` (`host-api.ts:4750`) has the same gap for the Installed-tab up arrow.

## Decisions

1. **Compatibility is proven, not inferred from version numbers.** A candidate whose major is
   higher than the installed major is checked against the package's own declared target
   frameworks through `NuGet.Frameworks` (`DefaultCompatibilityProvider`), which is
   authoritative. Same-major candidates are not checked, so an ordinary patch scan costs no
   extra request.
2. **Fail open.** When the feed publishes no framework data for a version, the project
   framework cannot be parsed, or the call fails, the candidate stays (today's behaviour).
   Unknown must never hide an update.
3. **The safety gate is independent of `allowMajorVersionOverride`.** The override opts into
   cross-major policy, not into an uninstallable version.
4. **Both surfaces agree**: the Updates scan (primary and `LatestOverallVersion`) and the
   Installed-tab arrow.
5. **Lane policy is unchanged.** The existing aligned-package rule still applies first;
   compatibility only removes what the lane rule allowed.

## Contract (core ↔ host)

New sidecar method `getPackageVersionCompatibility`.

Request:

```json
{
  "source": { "url": "…", "username": "…", "password": "…", "proxy": "…" },
  "id": "CommunityToolkit.Maui.MediaElement",
  "projectFrameworks": ["net10.0"],
  "versions": ["12.0.0"]
}
```

`projectFrameworks` are the row's target frameworks (all TFMs of the contributing projects for
a shared/unconditional row). `versions` is optional; omitted means "every listed version".

Response: an array, one entry per version the feed knows:

```json
[{ "Version": "12.0.0", "Compatible": false, "Known": true }]
```

- `Known: false` — the version declares no dependency groups (framework data unavailable), or
  no project framework could be parsed. `Compatible` is `true` in that case.
- A requested version missing from the feed's metadata is omitted; the host treats it as
  unknown/allowed.
- Declared frameworks come from the registration metadata's dependency groups, the same data
  the Details panel's Dependencies tab shows. No `.nupkg` download is performed.

## Core (.NET) changes

- `src/NugetPackageManager.Core.NuGet/Models/PackageVersionCompatibility.cs` — record with
  PascalCase JSON names `Version`, `Compatible`, `Known`.
- `src/NugetPackageManager.Core.NuGet/Sources/PackageFrameworkCompatibility.cs` — pure helper:
  - `ParseProjectFrameworks(IEnumerable<string>)` → `IReadOnlyList<NuGetFramework>?`; `null`
    when a non-empty name does not parse (`ParseFolder` + `IsSpecificFramework`, same rule as
    `PackageFrameworksBuilder.TryParseFramework`).
  - `Evaluate(version, declaredFrameworks, projectFrameworks)` → `PackageVersionCompatibility`.
    No dependency groups, unparseable project frameworks → `Known:false, Compatible:true`.
    `AnyFramework`/unspecified group → `Known:true, Compatible:true`. Otherwise
    `Compatible = projectFrameworks.All(pf => declared.Any(df => DefaultCompatibilityProvider.Instance.IsCompatible(pf, df)))`.
- `INuGetSource.GetVersionCompatibilityAsync(id, projectFrameworks, versions, ct)`.
- `ProtocolNuGetSource`:
  - Cache declared frameworks per id (`ConcurrentDictionary`, `packageCacheTtl`, cleared by
    `ClearPackageCache` for the id and for all).
  - Read `PackageMetadataResource.GetMetadataAsync(id, includePrerelease: true,
    includeUnlisted: false, …)` once per id, map `version → DependencySets.TargetFramework`,
    then evaluate the requested versions (all listed versions when `versions` is null/empty).
- `NuGetCoreHandlers`: dispatch entry `getPackageVersionCompatibility`, a `ReadStringArray`
  helper, `'id' is required` validation, `GuardAsync` like the other handlers.

## Host (TypeScript) changes

- `src/NugetPackageManager.VSCode.Host/nuget/source-api.ts` — `PackageVersionCompatibility`,
  `GetVersionCompatibilityResponse`, `INuGetSourceApi.GetVersionCompatibilityAsync`.
- `src/NugetPackageManager.VSCode.Host/nuget/sidecar-source-api.ts` — call
  `getPackageVersionCompatibility`; folder feeds route through the core as
  `getPackageFrameworks` already does.
- `host-api.ts`:
  - `InstalledPackageEntry.frameworks: Set<string>` — `resolution.Tfm` when it parses as a
    TFM, otherwise the contributing project's `TargetFrameworks`. Merged across projects.
  - `getVersionCompatibilityAsync(sourceUrl, id, frameworks, versions, signal)` helper:
    filters unparseable frameworks, calls the source API, returns
    `Map<version, { Compatible, Known }>`; logs a warning and returns `null` on failure
    (fail open). Exact-string match with a `compareVersions === 0` fallback.
  - `isKnownIncompatible(map, version)` helper.
  - Scan: after `selectAvailableVersions`, when any offered version has a major greater than
    the installed major, request compatibility for those versions plus `overallVersion` (row
    frameworks), drop known-incompatible versions, and suppress `LatestOverallVersion` when it
    is known-incompatible. Skip the row when nothing remains. Per-run cache keyed by
    source + id + frameworks + versions so two rows of the same package share one call.
  - Installed arrow: rename `applyLaneCap` flow to `applyLaneCapAsync(packageObj, request,
    sourceUrl, signal)` — run the existing lane cap, then, only when the recommended version
    is newer than `InstalledVersion` and crosses the installed major, lower it to the highest
    known-compatible candidate (or `InstalledVersion` when none is compatible). `Versions`
    stays intact for the picker. Use `Framework`; a condition label that does not parse is
    skipped.

## Tests

Core (`tests/NugetPackageManager.Core.NuGet.Tests`):

1. `PackageFrameworkCompatibilityTests` — `net10.0` vs only `net11.0` → incompatible;
   `net10.0` vs `netstandard2.0` → compatible; `net10.0-android36.0` vs `net10.0-android` →
   compatible; empty groups → `Known:false`; `AnyFramework` → compatible; unparseable project
   framework → `Known:false`.
2. `ProtocolNuGetSourceTests` — metadata with dependency sets: `GetVersionCompatibilityAsync`
   reports `12.0.0` incompatible for `net10.0`, `11.0.0` compatible; no dependency sets →
   `Known:false`; the metadata resource is queried once for two calls (cache).

Core handler (`tests/NugetPackageManager.Core.Tests/NuGetCoreHandlersTests.cs`):

3. Serialized response shape and source/credentials pass-through; missing `id` →
   `InvalidParams`.

Host (`tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Host/host-api.test.ts`):

4. Regression: single-major `net10.0` row, non-aligned package, installed `11.0.0`, feed
   `12.0.0` known-incompatible → no row (this is the reported bug).
5. Compatible newer version on the same TFM → offered.
6. Unknown compatibility (`Known:false`) → offered (no regression).
7. `allowMajorVersionOverride: true` with a known-incompatible overall version →
   `LatestOverallVersion` suppressed, lane version kept.
8. Installed arrow: latest `12.0.0` incompatible → arrow drops to the highest compatible
   version (or hides when none is newer).
9. Default `GetVersionCompatibilityAsync` stub (`Known:false`) added to the shared scan and
   lane-cap test fixtures so existing tests keep their behaviour.

## Docs

- `CHANGELOG.md` (Unreleased) — fix entry for the false update offer.
- `README.md` → Updates bullets / multi-framework section — a cross-major candidate is only
  offered when the package version declares a target framework the row can consume.

## Verification

1. `dotnet build NugetPackageManager.slnx -c Release`.
2. `dotnet test NugetPackageManager.slnx -c Release` (or the two touched test projects).
3. `npm run typecheck`, `npm run lint`.
4. Focused host tests (`npm test` with the host-api test file).
5. `npm run quality` before finishing.

## Out of scope

- Filtering same-major candidates by framework (kept off to avoid an extra metadata call on
  every ordinary patch update).
- The version picker's `Versions` list; the Details panel's Versions tab remains complete.
- Consolidate and Cleanup target selection.
- Reworking the aligned-package lane mapping (`CommunityToolkit.Maui.*` is deliberately not
  added: its major is TFM+1, so the lane rule would pin it to the wrong line).
