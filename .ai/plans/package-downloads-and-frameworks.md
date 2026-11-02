# Package downloads consistency + supported frameworks

Status: IMPLEMENTED
Date: 2026-11-02

## Problem

The Details panel shows `Downloads —` for a package selected from the **Updates** tab
(coverlet.collector) even though the Updates row shows `1122.4M`.

Cause: the Updates row dispatches only `{ packageId, sourceUrl }`. `packages-view`
selects the installed `projectsPackages` copy first, which was enriched from the first
configured feed that answered — in the report, **Microsoft Visual Studio Offline Packages**.
That feed publishes only version `6.0.0` and no `SearchQueryService`, so the Details panel
shows `—`, `Versions (1)` and the offline source badge. The update row's nuget.org
metadata and `sourceUrl` are ignored.

## Decisions (confirmed with the user)

- Details Downloads block: **Total** and **Current version** only (no per-day average).
- When the serving feed has no download data, **fall back to another configured feed**
  that has the package.
- Show **supported frameworks** (nuget.org Frameworks tab) instead of per-day average.

## Scope

### A. Downloads

1. Core model: `PackageVersionRef` gains `Downloads: long?`.
   - `ProtocolNuGetSource.SearchAsync`: map `VersionInfo.DownloadCount`.
   - `ProtocolNuGetSource.GetPackageAsync`: merge registration versions with the
     best-effort search lookup's `VersionInfo.DownloadCount` (same lookup that already
     supplies total downloads and verified).
2. Public types: `PackageVersion` in `types.d.ts` gains `Downloads?: number | null`;
   `PackageViewModel`/`OutdatedPackageViewModel` carry version downloads where needed.
3. Details panel: replace the single `Downloads` row with `Total` and
   `Current version` (downloads of the selected version, updated by the version dropdown).
   Rows in Browse/Installed/Updates keep showing total downloads.
4. Host popularity fallback: in `fetchPackageFromAnySourceAsync`, if the first successful
   source returns `TotalDownloads == null`, query the remaining configured sources and
   merge `TotalDownloads`, `Verified`, and per-version `Downloads` for versions that both
   feeds know. All configured sources are already contacted by the update scan, so this
   does not widen exposure. The metadata/versions/source badge stay from the first feed.
5. Selection consistency: `onChildPackageSelectedAsync` must honour a child's `sourceUrl`.
   When the installed entry came from another source (or has no popularity data), re-fetch
   metadata from the child's source before selecting, preserving `InstalledVersion`. This
   makes the Details numbers match the Updates row.

### B. Supported frameworks

6. Core: `INuGetSource.GetPackageFrameworksAsync(id, version, ct)`.
   - Open the package (HTTP feeds: `DownloadResource` + `PackageArchiveReader`;
     local feeds: the existing `.nupkg` file in the TS host).
   - Collect asset TFMs with the same pattern sets nuget.org uses (ref/lib/runtime,
     content, resource, MSBuild props/targets for the package id, tools for tool packages).
   - Expand compatibility against a maintained framework list with
     `DefaultCompatibilityProvider`; mark each entry declared (`IsComputed = false`) or
     computed.
   - Group by product (`.NET`, `.NET Core`, `.NET Standard`, `.NET Framework`, …) and sort.
   - Cache per id/version; read lazily only when the tab is opened.
7. RPC: sidecar method `getPackageFrameworks`; `INuGetSourceApi`/`SidecarSourceApi`
   method; `HostAPI.getPackageFrameworksAsync`; `types.d.ts` request/response.
8. Web: fourth `Frameworks` tab in `package-details`, loaded with `Task` on first open.
   Product groups with TFM chips, declared vs computed styling, loading/error/empty
   states, accessible table labels. No raw HTML.

### C. Tests

9. Core (MSTest): version downloads mapping; popularity merge; framework extraction +
   compatibility expansion + grouping; cache behaviour.
10. Host (Mocha/Sinon): fallback popularity merge; selection re-fetch from the row source.
11. Web (Mocha + JSDOM): Details shows Total/Current version and follows the selected
    version; Frameworks tab renders groups/chips and handles loading/error; Updates
    selection requests the row's source.
12. Verification: `dotnet build NugetPackageManager.slnx -c Release`,
    `dotnet test NugetPackageManager.slnx -c Release`, `npm run typecheck`, `npm test`.
    `npm run lint` for changed TS files.

## Non-goals

- Per-day average (user does not need it).
- Searching/browsing by framework filter.
- Changing feed precedence for existing metadata resolution.

## Risks

- Framework expansion must match nuget.org closely; the known-framework list is versioned
  in the core and covered by tests. Packages with no assets report an empty state.
- Downloading a `.nupkg` for frameworks is lazy and cached; it never runs for Details
  opening or for the package rows.
