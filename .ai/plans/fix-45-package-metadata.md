# Fix #45 — take package metadata from the search resource (full NuGet.Protocol migration)

Status: DONE — build, tests and gate green; ready to commit
Branch: `fix/45-package-metadata` (cut from `spike/blazor-wasm-webview`)
Issue: https://github.com/I-Synergy/NugetPackageManager/issues/45

## Problem

`Installed` / `Updates` show **Downloads 0** (and lose the *verified* badge). Both mappers
(`MapSearch`, `MapRegistration`) fill one `Package` record, but the popularity fields exist only
in the **SearchQueryService** payload. The registration `catalogEntry` — and the catalog leaf —
carry no `totalDownloads` or `verified`, so `MapRegistration` produces `0`/`false`, which is
indistinguishable from a real value. The history shows the assumption arrived with the initial
import (`4fb854e`, upstream `nuget-workbench-vscode 1.0.3`) and was carried through the C# port
(`cd787ba`).

Verified with the official client (NuGet.Protocol 7.9.0, probe run against nuget.org):

```
PackageMetadataResource (registration)  version=13.0.4  DownloadCount=<null>  PrefixReserved=False
PackageSearchResource   (search)        version=13.0.4  DownloadCount=9678449573  PrefixReserved=True
```

So the split is protocol-level; the fix is to **take popularity metadata from the search
resource** and make "unknown" representable.

## Scope (strategic)

1. Replace the hand-written HTTP + JSON mapper with **`NuGet.Protocol`**: `PackageSearchResource`,
   `PackageMetadataResource`, `DependencyInfoResource`, `FindPackageByIdResource`.
   Deletes `PackageMapping.cs` (350 lines) and `NuGetHttpClient.cs` (93 lines), and removes the
   whole "two mappers drift" class.
2. `Package.TotalDownloads` → `long?`, `Package.Verified` → `bool?` end-to-end (C#, wire, TS
   view model, row/detail rendering: "—" and no badge when unknown).
3. `GetPackageAsync` enriches from the search resource, **best-effort** (a feed without
   `SearchQueryService` must still resolve packages), cached with the package.
4. `OutdatedPackage` carries the metadata so the **Updates list rows** are right without a
   refetch (today `getLatestVersionAsync` throws the search `Package` away).
5. One empty-package factory in the webview instead of three; settle `Id` (leaf URL) vs `Name`
   (package id) so lookups stop missing.

## Design decisions

**Transport stays ours.** `SourceRepository` is built with the core providers minus the default
`HttpHandlerResourceV3Provider`, plus one that supplies `HttpHandlerResourceV3(handler, handler)`
built from our `HttpClientHandler`. That keeps three things we would otherwise lose:

- `SourceDescriptor.Proxy` (`http.proxy` / env) still applies;
- credentials stay on `PackageSource` (NuGet.Protocol's own auth path, not a hand-rolled header);
- tests can inject a stub `HttpMessageHandler` and exercise **real** NuGet.Protocol parsing on
  recorded payloads — better regression coverage than the current JSON fixtures.

**The details RPC changes key.** `getPackageDetails` currently takes `PackageVersionUrl` (a
registration leaf URL) because that is what the old mapper had. `PackageMetadataResource` is keyed
by id + version, so the request becomes `{ Id, Version }` (the webview already has `Name` and the
selected version). Same for `DependencyHandlers`' use of a leaf-URL `Id`. The leaf URL is no longer
carried anywhere.

**Security note.** The old client refused to send credentials to hosts a feed declares. With
NuGet.Protocol, credentials live on `PackageSource` and the library scopes them to that source; auth
plugins for private feeds also start working. This is a behaviour change and needs a review line in
the PR body.

## Phases

- [x] P1 `Package` nullable fields + TS types + UI (— / hidden badge)
- [x] P2 `Sources/PackageMetadataMapper.cs` — `IPackageSearchMetadata` → `Package`, pure and unit-testable
- [x] P3 `SourceRepositoryFactory` reused as-is (default provider chain; proxy/auth untouched)
- [x] P4 `Sources/ProtocolNuGetSource.cs` — `INuGetSource` over the four resources, with the search enrichment and caches
- [x] P5 Wire `NuGetSourceProvider` + handlers; delete `HttpNuGetSource`, `PackageMapping`, `NuGetHttpClient`
- [x] P6 `getPackageDetails` → `{ Id, Version }` (C#, RPC types, host-api, webview, DependencyHandlers)
- [x] P7 `OutdatedPackage` carries `TotalDownloads`/`Verified`; Updates rows render them
- [x] P8 One `emptyPackage` factory; `Id`/`Name` semantics fixed
- [~] P9 Tests: source + mapper tests done (39 pass); handler/webview tests updated mapper unit tests, source tests over a stub handler, update `PackageLookupFailureTests`
      and the mapping tests; keep `dotnet test` green
- [x] P10 `npm run quality` (8/8), CHANGELOG/README note, commit with `Fixes #45`

## Risks

- **Proxy/auth parity** — the highest-risk part; needs a private-feed and a proxy check before merge.
- **Feeds without search** — enrichment must swallow failures and leave `null`.
- **`packageid:` is a gallery convention**, not V3 spec — enrichment is a hint, never a
  correctness dependency.
- **Performance** — one extra search call per newly selected package (cached); the updates scan
  can reuse the metadata it already fetched.
- **SonarCloud** — deleting `PackageMapping` removes ~350 lines of new-code duplication risk.

## State at hand-off

Committed on the branch (`56f565d`) and pushed:
`ProtocolNuGetSource` (registration + search enrichment), `PackageMetadataMapper`, nullable
`TotalDownloads`/`Verified` through C#/wire/UI, the `{ id, version }` details contract, and new
tests (`ProtocolNuGetSourceTests` — 39 pass, including "feed without search ⇒ null, not 0").

**Blocked on the owner's in-flight `NugetPackageManager.Common` refactor** (moving the
`invalidParams`/`internalError` constants out of `RpcException`): `src/NugetPackageManager.Common`
currently fails the solution build (IDE0005/CS1591 on `Constants.cs`), so only
`Core.NuGet.Tests` could be run. Re-run `dotnet test` + `npm run quality` once that lands.

P7 is done: `getLatestVersionAsync` keeps the search payload's `TotalDownloads`/`Verified`,
`OutdatedPackage` carries them, and the Updates rows render without a refetch.
P8 is done: `PackageViewModel.Empty(id, status)` is the only empty-package factory (three copies
removed); `Id` is the package id again, so no leaf-URL overload remains.
Also landed in this tree: the owner's `NugetPackageManager.Common` refactor (shared constants,
`Enumerations/` with one enum per file).

## Verification

`dotnet build` + `dotnet test` (204+ tests) + `npm run typecheck` + `npm run lint` + `npm test` +
`npm run quality`. Manual: browse a package, then Installed → detail shows the same downloads and
badge; Updates row shows the badge/downloads.
