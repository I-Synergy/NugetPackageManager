# Framework lanes in multi-.NET workspaces

Status: APPROVED (2026-11-08)
Started: 2026-11-08
Progress: `.ai/progress/framework-lane-major-override.md` (to be created)

## Problem

When a project or workspace targets more than one .NET major (e.g. a multi-targeting
library `net8.0;net10.0`, or a `net11.0` project next to a `net10.0` one), framework-aligned
packages can leave their TFM's major line:

1. `selectAvailableVersions` (`src/NugetPackageManager.VSCode.Host/host-api.ts`) falls back to
   **all** feed versions when the TFM's major line has no newer version. A net10 line whose
   latest 10.x is already installed is therefore offered `11.0.0-rc` (or `11.0.0`) as its
   primary update — the "historical fallback" that predates multi-framework support.
2. Shared/unconditional CPM resolutions carry `Tfm = ""`, so `getTfmMajorVersion` returns
   `null` and alignment never applies to them at all.
3. The Installed-tab update arrow targets `Package.Version` from `getPackageAsync`, i.e. the
   overall latest, with no TFM context — so it can advertise `11.0.0-rc` for a net10 row too.

## Decisions (user-confirmed, 2026-11-08)

1. **Strict lanes in multi-.NET-major scopes.** When the projects in scope target more than one
   .NET major, every framework-aligned row stays on its TFM's major (same major only; previews
   of the next major included in "no"). A scope with a single major (e.g. every project
   `net8.0`) keeps today's behaviour and may cross majors.
2. **New setting** `nugetpackagemanager.allowMajorVersionOverride` (boolean, default `false`):
   - `false` — no cross-major version is offered for an aligned row in a multi-major scope, not
     even through the secondary action.
   - `true` — restores the intentional escape hatch: `LatestOverallVersion` as the secondary
     Updates action, and the overall latest as the Installed-arrow target.
3. **Both surfaces** follow the rule: Updates tab and the Installed-tab arrow.

## Lane semantics

- **Scope multi-major** = more than one distinct major among all target frameworks in scope.
- **Row lane** = major of the row's resolved TFM when it has one; for a shared row (`Tfm = ""`),
  the **lowest** major among the TFMs of the projects carrying that row (a shared version must
  satisfy the most constrained framework).
- **Aligned** = package matches `frameworkAlignedPackages` and a lane major exists.
- Candidate selection:
  - multi-major + aligned + override `false`: only versions whose major equals the lane. No
    fallback to `allVersions`; `LatestOverallVersion` is not set.
  - multi-major + aligned + override `true`: today's behaviour (lane first, overall fallback and
    secondary action).
  - single-major or no lane: today's behaviour (lane first when it has a newer version, else
    overall) — the user's "all .net 8 can still move up" case.

## Changes

### Host — Updates scan (`src/NugetPackageManager.VSCode.Host/host-api.ts`)

- `getCpmSettings()` gains `allowMajorOverride` (reads the new setting).
- `buildInstalledState(projects)` computes `multiMajor` from the parsed projects and passes it
  through `runOutdatedScanAsync` → `collectOutdatedCandidatesAsync`.
- `mergeInstalledEntry` / `InstalledPackageEntry` record the row's framework majors:
  `resolution.Tfm` when non-empty, otherwise the contributing project's `TargetFrameworks`; keep
  the lowest major as `laneMajor`.
- `selectAvailableVersions` takes the multi-major flag and the override setting, applies the
  semantics above, and stops falling back for strict multi-major rows.
- `buildOutdatedCandidateAsync` carries an explicit `overallVersion` (unset when the override is
  off) so `buildOutdatedEntry` only emits `LatestOverallVersion` when cross-major is allowed.

### Host — Installed arrow (`getPackageAsync`)

- `src/NugetPackageManager.VSCode.Common/rpc/types.ts`: `GetPackageRequest` gains optional
  `Framework?: string` (row TFM, empty for shared), `ScopeTargetFrameworks?: string[]` (all TFMs
  in the loaded scope, for multi-major detection) and `InstalledVersion?: string`.
- After the package is fetched (from any source), the host caps the recommended
  `Package.Version` when: the package is aligned, the scope is multi-major, the override is off,
  and a lane exists. Recommended = highest version on the lane that is newer than
  `InstalledVersion`; when there is none, `Package.Version` = `InstalledVersion` so
  `package-row` hides the arrow (`Version !== InstalledVersion` no longer holds). `Versions`
  stays intact for the version picker.

### Webview

- `src/NugetPackageManager.VSCode.Webview/components/packages-view.ts`: accumulate the TFMs per
  installed group (the row's `CpmFramework`, or the source projects' TFMs for shared rows) and
  the scope TFMs from `projectsToUse`; pass `Framework`, `ScopeTargetFrameworks` and
  `InstalledVersion` to `getPackageAsync` from `UpdatePackageAsync` and
  `RefreshInstalledPackageFromSourceAsync`. Other `getPackageAsync` call sites (browse, details)
  are unchanged.
- `updates-view`: no selection change needed; its primary `LatestVersion` is already what the
  host returns. Update the info banner to mention the new setting.
- `settings-view.ts`: checkbox "Allow framework-aligned packages to cross their TFM's major
  version" that persists the setting through `updateConfigurationAsync`.

### Configuration contract

- `package.json`: `nugetpackagemanager.allowMajorVersionOverride`, boolean, default `false`,
  description naming the multi-major rule.
- `src/NugetPackageManager.VSCode.Common/configuration.ts`: add the key to `CONFIG_KEYS`.
- `src/NugetPackageManager.VSCode.Common/types.d.ts`: `Configuration.AllowMajorVersionOverride`.
- `host-api.ts`: read it in `getConfigurationAsync` and write it in `updateConfigurationAsync` only
  when it differs, following the existing keys.

## Tests

Host (`tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Host/host-api.test.ts`):

1. Multi-major scope, net10 line, feed `[10.0.13, 11.0.0-rc.3]`, override off → no update row and
   no `LatestOverallVersion`.
2. Same with `10.0.14` on the lane → `LatestVersion = 10.0.14`, no `LatestOverallVersion`
   (override off); with override on → `LatestOverallVersion = 11.0.0-rc.3`.
3. Shared unconditional resolution in a multi-target `net8.0;net10.0` project → lane 8, no
   10.x/11.x offer.
4. Single-major scope (all `net8.0`) → existing cross-major fallback preserved.
5. `getPackageAsync` with `Framework: net10.0`, scope `[net8.0, net10.0]`, installed `10.0.13`,
   versions `[10.0.13, 11.0.0-rc.3]` → `Package.Version = 10.0.13` (arrow hidden); with
   `10.0.14` → `10.0.14`; override on → `11.0.0-rc.3`.

Webview:

6. `settings-view.test.ts`: toggling the new checkbox sends `AllowMajorVersionOverride` in
   `updateConfigurationAsync` and updates local configuration.
7. `packages-view.test.ts`: installed rows pass their framework/scope and the arrow disappears
   when the recommended version equals the installed version.

## Docs

- `README.md` (multi-framework version management) and `CHANGELOG.md` describe the lane rule and
  the new setting.

## Verification

1. `npm run typecheck` and `npm run lint`.
2. Focused host + webview tests.
3. `npm run quality` (full gate; C# is untouched but the gate includes it).
4. Manual check on a multi-targeting library fixture: net10 row primary stays 10.x and the
   Installed arrow does not offer 11.x; enabling the setting restores the latest-overall action.
