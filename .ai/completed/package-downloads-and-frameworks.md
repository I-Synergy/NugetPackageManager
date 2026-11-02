# Package downloads consistency + supported frameworks

Status: IN PROGRESS
Started: 2026-11-02
Plan: `.ai/plans/package-downloads-and-frameworks.md`

## Steps
- [x] Core: version download counts, popularity fallback fields, frameworks service + handler + tests
- [x] Host: types/RPC, sidecar adapter, cross-feed popularity merge, selection source fix + tests
      (selection source fix lives in the webview's `onChildPackageSelectedAsync` — Web step)
- [x] Web: Details Total/Current version, Frameworks tab, selection wiring + tests
- [x] Verify: dotnet build/test, npm typecheck, npm test, lint changed files

**Status:** DONE

## Notes
- Confirmed root cause: Updates rows dispatch `sourceUrl`, but `onChildPackageSelectedAsync`
  selects the installed copy enriched from the first configured feed (offline feed in the
  report), so Details shows no downloads and only the installed version.
- Decisions: Total + Current version only; fall back to another configured feed for missing
  downloads; supported frameworks replace per-day average.

## Core step (C#) — done
- `PackageVersionRef` now carries `Downloads` (JSON `Version`/`Downloads`, default `null`).
  `SearchAsync` maps `VersionInfo.DownloadCount` per version; `GetPackageAsync` merges the
  search hit's per-version counts onto the registration list by normalized version
  (ordinal-ignore-case) and leaves unmatched versions `null`.
- New records `PackageFrameworkItem` / `PackageFrameworkGroup` / `PackageFrameworks`
  (JSON `Name`/`IsComputed`, `Product`/`Frameworks`, `Groups`).
- `INuGetSource.GetPackageFrameworksAsync(id, version, ct)`; `ProtocolNuGetSource` resolves
  `DownloadResource` as a third resource, downloads the `.nupkg`, reads its typed item groups
  plus the file list (`buildTransitive`, `ref`, `runtimes`), and hands both to
  `PackageFrameworksBuilder` (static, HTTP-free): a ported nuget.org known-framework list
  crossed with `DefaultCompatibilityProvider`, platform-version normalization like nuget.org,
  product grouping/ordering, and declared vs computed flags. Cached per `id|version` and
  cleared with `ClearPackageCache`.
- Sidecar handler `getPackageFrameworks` (`{ source, id, version }`).
- Note: NuGet 7.9.0's `DownloadResource` only exposes the 5-argument
  `GetDownloadResourceResultAsync`, so the call passes `globalPackagesFolder: null`
  (in-memory result) rather than the 4-argument form in the task brief.
- Tests added for per-version mapping, merge/no-search behaviour, framework expansion,
  grouping/ordering, platform normalization, tool gating and cache reuse.

## Host step (TypeScript) — done
- `types.d.ts`: `PackageVersion` gains `Downloads?: number | null`; new `PackageFrameworkItem`
  (`Name`/`IsComputed`), `PackageFrameworkGroup` (`Product`/`Frameworks`) and `PackageFrameworks`
  (`Groups`).
- `rpc/types.ts`: `GetPackageFrameworksRequest` (`SourceContext & { Id, Version }`),
  `GetPackageFrameworksResponse` (`{ Groups }`) and `HostAPI.getPackageFrameworksAsync`.
- `nuget/source-api.ts`: `INuGetSourceApi.GetPackageFrameworksAsync(id, version, signal?)`
  returning `{ data: PackageFrameworks }`; `sidecar-source-api.ts` implements it by calling the
  sidecar's `getPackageFrameworks` with `{ id, version }`. Local sources go through the core too
  (NuGet.Protocol opens a folder feed's `.nupkg`); a core failure is thrown to the caller, never
  turned into an empty list.
- `nuget/local-feed.ts`: folder-feed versions carry `Downloads: null`.
- `host-api.ts`: `getPackageFrameworksAsync` resolves the source the same way
  `getPackageDetailsAsync` does and returns `{ Groups }`; `fetchPackageFromAnySourceAsync` keeps
  the first successful feed's metadata/source and, when its `TotalDownloads` is `null`, scans the
  remaining configured feeds and merges popularity (`TotalDownloads`, `Verified`, per-version
  `Downloads` for versions the primary already has); `searchAcrossSourcesAsync` does the same
  merge for duplicate ids instead of dropping them.
- Tests: 4 in `host-api.test.ts` (`getPackage across sources`: merge keeps source/versions and
  fills downloads, stop at the first feed with popularity, null popularity retained, fail when no
  feed knows it), 3 for `getPackageFrameworks` (pass-through + `Result`, required source url,
  source failure surfaced) and 1 in `local-feed.test.ts` (versions expose `Downloads === null`).

## Web step (TypeScript) — done
- `view-models/package-view-model.ts`: `VersionDownloads: Map<string, number | null>` plus
  `DownloadsForVersion(version)`; filled from `model.Versions` in the constructor and in
  `UpdatePackage` (so a refreshed package replaces its counts), empty for `Empty()`. `Versions`
  stays `string[]` for existing callers.
- `components/package-details.ts`: Description tab now shows `Total` (`package.TotalDownloads`)
  and `Current version` (`package.DownloadsForVersion(selectedVersion)`); one `formatDownloads`
  with K/M/B compaction and the em dash for unknown. Fourth `Frameworks` tab (order: Description,
  Dependencies, Frameworks, Versions) backed by a second `@lit/task` keyed on
  `[package?.Name, selectedVersion, source, passwordScriptPath, activeTab]` — the tab is part of
  the keys, so the (expensive) request only fires when the tab is open and re-fires on a version
  change. Results are tagged with their id/version/source key so a stale response is never
  rendered. Renders product groups with `.tfm-badge` chips, `is-computed` for compatible-only
  entries, a spinner while pending, a retry-worded error on failure and an empty state for
  `Groups.length === 0`. No raw HTML; `role="tab"`/`aria-selected` kept.
- `components/packages-view.ts`: `onChildPackageSelectedAsync` now honours the child's
  `sourceUrl` — when the installed copy came from another feed (or has no popularity data) it
  re-fetches via `getPackageAsync({ Id, Url: sourceUrl, Prerelease, SourceName?, PasswordScriptPath? })`
  using the row source's own credentials, updates it (`UpdatePackage(model, sourceUrl)`),
  preserves `InstalledVersion` and sets `Status = "Detailed"`; a failed fetch keeps the existing
  package and still selects it. Browse path unchanged.
- Tests: 6 in `package-details.test.ts` (Total/Current version follow the selected version, em
  dash for unknown, frameworks request args + groups/chips/declared-vs-computed, re-request on
  version change, spinner, error, empty, lazy), 4 in `view-models/package-view-model.test.ts`
  (per-version lookup incl. null/absent, UpdatePackage refresh, Empty) and 4 in
  `packages-view.test.ts` (refetch from the row source incl. SourceName/PasswordScriptPath,
  no refetch when the source matches, failed refetch keeps + selects, browse row untouched).

