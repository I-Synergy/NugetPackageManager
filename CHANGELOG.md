# Changelog

## Unreleased

- fix: Cleanup's duplicate analysis now uses the same project scope as the rest of the extension — the solution's projects when a solution exists, otherwise workspace projects minus `excludeGlobs`/hidden folders. Previously it globbed every `.csproj`, so a cached tree such as `.ai/tmp/catalog-cache` was analysed and its 32 foreign projects were restored on tab open. The automatic restore is also capped at 20 projects per pass.
- feat: opening Cleanup restores projects without a fresh `project.assets.json` (progress in the section, one attempt per open, **Restore again** on failure), so the duplicate analysis always covers the whole solution.
- feat: the Cleanup tab lists **direct references the restore graph already provides transitively**, computed per TFM from `obj/project.assets.json` with the chain (`Parent -> … -> Package`). Only references whose removal does not lower the resolved version are removable (**Remove** / **Remove all safe**, confirmed and run through the snapshot + restore + rollback job); a reference that raises a version is marked **pinned — kept** and never offered. The tab badge counts unused entries plus removable duplicates.
- feat: a restore that fails on the vulnerability audit (`NU1900`–`NU1905` promoted to errors) is classified as a vulnerability-audit failure, naming the affected packages and severity, with an **Open advisory** action in the error card — previously it was reported as a version conflict with a misleading "pin the package" hint.
- feat: the change plan is **ordered in dependency steps** (`Step 1:`, `Step 2:`, …) — a set that cannot be installed in one go can be applied across sessions, dependencies first. Selected packages are ordered after the requirements they pull in.
- feat: the preflight follows the **transitive requirement closure** (new version → sibling → its own dependencies), so the plan lists every package that has to move, not only the first level; bounded to 250 inspected packages.
- feat: the preflight now presents one **change plan** — direct references, unconditional central raises, and per-TFM requirements that need conditional `<PackageVersion>` groups — attributed to the dependency group of each project's target framework. When conditional or unresolved items exist it stops before writing anything instead of applying a partial (or wrong) central version.
- feat: the batch preflight now also **raises central `PackageVersion` entries** in `Directory.Packages.props` for versions a preview set requires (one write, then one restore) — a CPM pin applies to transitive dependencies too, so an old central value blocks newer packages. Requirements with no resolvable version are listed separately instead of pretending to be updates.
- feat: when the batch preflight blocks a selection, it now offers to **include the sibling packages those versions require** at the exact version the conflict asks for, then re-checks — instead of dead-ending on "Update the other 0 packages?". Required packages that are not offered as updates are named in the dialog.
- feat: NuGet version conflicts (`NU1107` / `NU1605` / `NU1608`) expose a **Pin `<Package>` to `<version>`** action on the error card. It writes the suggested version to the CPM group (auto-detected) or the project `PackageReference`, restores, and reports the result instead of leaving the user to hand-edit files.
- fix: `dotnet` now runs in the directory that owns the project's nearest `global.json`. SDK selection reads `global.json` from the working directory, not from the project path in `argv`, so the extension previously ignored the solution's pinned SDK and used the newest installed one — on a machine with a preview SDK that fails SDK resolution, every restore failed and transactional updates rolled back. Applies to restore, install, update, uninstall, conflict fixes and `dotnet msbuild -getProperty` target-framework evaluation; that evaluation also no longer fails silently into the XML fallback.
- feat: failed restores are classified into a cause (`WorkloadManifestConflict`, `SdkResolutionFailure`, `SdkPinMismatch`, `PinnedSdkMissing`, `RestoreConflict`, `SourceUnavailable`, `PasswordScriptFailed`, `DotnetMissing`) with a one-line summary and an actionable hint, instead of a multi-kilobyte MSBuild stack.
- feat: the package view shows a **dotnet toolchain** banner when the selected SDK ignores the `global.json` pin, the pinned SDK is missing, or a real project evaluation fails; the Updates tab and settings show the cause with **Show output** for the raw text.
- feat: **Re-check** in the Toolchain tab and in the toolchain banner shows an indeterminate progress bar and disables the button until the probe finishes; the banner no longer disappears while it runs.
- feat: a **Toolchain** tab (last in the tab bar) shows the selected .NET SDK, the `global.json` pin, the workspace override, the `dotnet` host in use, per-issue causes with hints and raw output, and the SDK selector with **Install**. Its badge counts the current toolchain issues.
- feat: an **SDK selector** in the Toolchain tab, the toolchain banner and *Settings → dotnet toolchain* lists the installed SDKs and writes the chosen version into the workspace's `global.json` (`sdk.version` only; comments and other keys are preserved, and a `global.json` is created at the workspace root when missing). The pin lives in the repository, not in `settings.json`.
- feat: the toolchain check reports the SDK **MSBuild resolves** (`GETPROPERTY NETCoreSdkVersion`) alongside `dotnet --version`, and flags a mismatch — the build value is authoritative.
- feat: SDK patch/out-of-support status comes from the official `dotnet sdk check` (cached for 10 minutes, `Unavailable` offline, refreshed by **Re-check**).
- feat: a missing `global.json` is created with Microsoft's `dotnet new globaljson` template; the surgical writer still edits existing files and is the fallback when the template cannot run.
- fix: pinning an SDK now keeps `global.json` coherent instead of only rewriting `sdk.version`: `sdk.rollForward` is set to `disable` (exact pin, matching the SDK the selector shows), `sdk.allowPrerelease` is set for prerelease SDKs, `sdk.workloadVersion` is dropped when it targets a different feature band, and `tools.dotnet` follows the pin. The selector reports every adjustment it made.
- feat: the Toolchain tab lists left-over `sdk-manifests\<band>` folders and offers **Copy cleanup command** (an elevated `Rename-Item` per band, rename rather than delete). Only stable bands are reported; prerelease bands installed by Visual Studio are excluded.
- feat: workload-manifest issues name left-over `sdk-manifests\<band>` folders whose SDK is no longer installed — neither `dotnet workload update` nor `repair` removes them, and they break SDK resolution for newer SDKs.
- feat: **Update workloads** / **Repair workloads** actions on workload-manifest issues run `dotnet workload update|repair` for the selected SDK after confirmation, report the raw output, detect an elevation failure, and re-check the toolchain.
- feat: when `global.json` pins an SDK that is not installed, the selector offers **Install `<version>`**, which downloads Microsoft's official `dotnet-install` script and installs that SDK under the user profile (trusted workspace, explicit confirmation), then pins it in `global.json` and re-checks the toolchain.
- feat: **Copy dotnet Toolchain Diagnostics** (`nugetpackagemanager.copyToolchainDiagnostics`) and *Settings → dotnet toolchain* copy a redacted report with the selected SDK, pin, nearest `global.json`, per-project working directory, `dotnet --list-sdks` and `dotnet --info`; the same report goes to the output channel.
- chore: add a quality gate mirroring the CI workflow — `npm run quality` builds, lints with ESLint + SonarJS, type-checks, runs the test suite and audits dependencies; `npm run quality:coverage` also writes `coverage/lcov.info` for SonarQube Cloud.
- ci: add the `Quality Gate` workflow; SonarCloud analysis is handled by its GitHub integration (automatic analysis), configured by `.sonarcloud.properties`, so no scanner or `SONAR_TOKEN` is required.
- fix: clear the SonarQube Cloud findings for product code — dead stores, unused collections/variables, redundant comparisons and type aliases, duplicate character classes, deprecated OpenTelemetry constants, writable static styles, message-origin verification in the RPC client, locale-independent cache keys, throwing non-`Error` values, and all cognitive-complexity hotspots (extracted helpers instead of suppressing).
- ci: scope SonarCloud automatic analysis to product paths (`.ai/**` skill templates and `docs/**` mockups excluded) and harden the workflows (`npm ci --ignore-scripts`, no `npx`, pinned release action).
- refactor: release versions are now automatic and follow the AI-repo scheme — each push to `main` derives `YYYY.1MMdd.1HHmm` from the UTC build time, publishes with that version, and tags it without a `v` prefix. The manual release script and `RELEASE_NOTES.md` were removed.
- docs: add CI, quality-gate, SonarCloud and Marketplace badges to `README.md`, and document the automatic release flow.

## 2.2.0 (2026-10-28)

- fix: a slow update on a large solution is no longer cancelled and reverted by the webview's 120 s request deadline. The deadline now stops the webview waiting but lets the host finish; files are only rolled back for a real write/restore failure or an explicit cancel.
- feat: every long mutation now runs as a host-side job — batch update, single package install/update/uninstall, consolidation and cleanup (`start*Async` → `{ JobId }`, `getJobAsync`, `cancelJobAsync`). The operation survives the tab being closed, a slow restore can no longer turn into a client timeout error, and the Updates tab renders live stage/percentage progress. Only one batch update runs at a time so two transactions cannot overwrite each other.
- fix: cancelling a batch update rolls back the versions it already wrote instead of leaving a partially applied update. A **Cancel** action is available while any long operation runs — batch updates, install/update/uninstall, consolidation, cleanup and "remove from all projects" — and reports what was rolled back or left applied.
- feat: batch updates are **preflighted** against the restored dependency graph before anything is written (`checkBatchUpdateAsync`). A selection that would break a pin is listed in a confirmation dialog, and the conflicting rows are skipped instead of failing the whole transaction.
- fix: a transactional batch no longer restores once per non-CPM package (`dotnet add --no-restore`); one `dotnet restore` covers the whole batch.
- feat: when the final restore does fail, the rollback names the packages responsible and offers **Retry without** them, so one bad row no longer costs the rest of the selection.
- feat: the restore phase streams `dotnet` stages and per-project progress into the job instead of a frozen progress bar.

## 2.1.0 (2026-10-26)

- fix: toggling **Prerelease** now clears the stale update count and rechecks it for the new filter. The Updates tab badge and the Activity Bar badge no longer keep the prerelease count.
- feat: the Updates tab shows live progress while checking (`Parsing projects (2/8)`, `Checking latest versions (23/60)`, …) with a determinate progress bar instead of an indefinite spinner.

## 2.0.0 (2026-10-26)

- breaking: the extension is now **NuGet Package Manager for Visual Studio Code** (`nugetpackagemanager`, extension ID `I-Synergy.nugetpackagemanager`). Commands, the webview panel, views, settings and the persisted scan key use the `nugetpackagemanager.*` namespace. The legacy `i-synergy-nugetpackagemanager.*` settings and `nugetpackage.*` command IDs are gone without compatibility shims, so existing keybindings and settings must be recreated. The view container ID changed, so its Activity Bar placement resets once. This is a new Marketplace listing; the earlier 2.0.0 build under the previous ID was unpublished, so existing installations will not auto-update.
- feat: the update badge tooltip now also reports how many updates are blocked by dependency conflicts.
- fix: restore failures now surface the real `dotnet` diagnostics, including the full `NU1107` constraint chain and the dependencies that declare the conflicting ranges.
- fix: a failed restore after a single install, update or uninstall rolls back the project file and `Directory.Packages.props` instead of leaving the workspace modified.
- feat: update suggestions are capped to versions accepted by installed dependencies (using `project.assets.json` and NuGet dependency metadata). Unsafe versions appear in a **Dependency conflicts** section with the blocked version and the packages/ranges that pin it, and the latest-overall action remains an explicit override.
- test: cover NU1107 parsing, single-update rollback, dependency-range capping and the held-back UI.
- docs: state explicitly that the extension restores after a write and never invokes `dotnet build`; a regression test asserts no build command is run.
- perf: dependency-constraint checks now fetch metadata only for packages that directly declare a dependency on a candidate, instead of the whole transitive closure.
- perf: reuse `dependencyGroups` embedded in NuGet registration data, so opening package details or checking a constraint no longer issues a second request for the same version.
- perf: the latest-version check concurrency is configurable via `theNugetPackageManager.updateCheckConcurrency` (default 8, was hard-coded to 5).
- feat: the Updates tab now paints the last persisted scan immediately (with update actions disabled) and refreshes in the background; selections are preserved across the refresh.
- perf: NuGet HTTP responses are cached on disk for 30 minutes under the extension's global storage; Reload clears the HTTP cache.
- chore: log per-phase timings for the Updates scan (project parse + TFM sources, latest-version checks, constraint checks).

## 1.2.14 (2026-10-26)

- feat: add select/deselect-all controls to each Updates framework group (Shared, net10.0, net11.0, etc.), with indeterminate state.

## 1.2.13 (2026-10-25)

- fix: refresh project and package data after a successful update so installed versions and update rows reflect the write immediately.
- test: cover the post-update refresh event.

## 1.2.12 (2026-10-24)

- feat: support local folder NuGet sources by scanning `.nupkg` files and reading embedded `.nuspec` metadata, versions and dependencies.
- fix: keep local folder sources during source resolution instead of treating the drive letter as an unsupported URL protocol.
- chore: add `jszip` as a runtime dependency for local package archives.

## 1.2.11 (2026-10-24)

- feat: framework selectors now collapse platform TFMs (windows/android/ios) to their base `.NET` line and expose **Shared** as a separate option; selecting a `.NET` line excludes shared packages.
- feat: a single global framework selector is shared by Installed, Updates and Consolidate, removing duplicate controls and duplicate Shared entries.
- fix: Updates keeps installed framework lines in the selector even when they have no current outdated row.
- fix: Updates content now scrolls correctly in the constrained tab layout.
- refactor: framework option building, matching and grouping live in `src/common/framework.ts`.
- test: cover platform-TFM normalization, shared filtering and single-selector behavior.

## 1.2.10 (2026-10-24)

- fix: exclude every dot-directory (`.git`, `.vs`, `.vscode`, `.github`, `.ai`, `.reasonix`, etc.) from project, CPM and cleanup scans.
- chore: replace the specific hidden-directory defaults with `**/.*/**`.

## 1.2.9 (2026-10-24)

- fix: hard-exclude `.ai/` and `.reasonix/` from every project, props and cleanup scan, so scratch/fake projects can never break Cleanup or be treated as solution projects.
- test: add Cleanup coverage proving `.ai/tmp/...` projects are ignored.

## 1.2.8 (2026-10-24)

- fix: use light/dark tab icons so the NuGet Package Manager editor-tab icon is visible in dark and light themes.
- perf: add a guarded literal XML target-framework fast path, falling through to assets/MSBuild for conditional TFMs.

## 1.2.7 (2026-10-24)

- fix: stop rendering the literal string `false` in the Projects pane during loading.
- perf: resolve target frameworks from the existing `obj/project.assets.json` first, avoiding one `dotnet msbuild` process per project on first load; MSBuild remains the fallback.

## 1.2.6 (2026-10-24)

- fix: Consolidate and Vulnerabilities now retain all framework-scoped CPM resolutions when a package has no single `Version`, matching Updates and Installed.
- feat: add the framework selector to Consolidate for reviewing and consolidating net10.0/net11.0 lines separately.
- docs: add the mandatory multi-TFM regression checklist to `AGENTS.md`.

## 1.2.5 (2026-10-24)

- fix: framework-scoped CPM packages with separate net10.0/net11.0 versions are no longer dropped from Updates when the package has no single version.
- feat: add the target-framework selector to the Updates tab so each framework line can be reviewed and updated separately.
- feat: show a loading indicator and status in the Projects pane while discovery and TFM resolution run; keep the previous list visible during refresh.
- feat: collapse the Projects sidebar by default.

## 1.2.4 (2026-10-24)

- docs: fix README TOC anchors, align workflow sections with the actual tab order (Browse, Installed, Updates, Consolidate, Vulnerabilities, Cleanup), and add a real VS Code Activity Bar/sidebar screenshot.
- chore: publish the corrected README and screenshots.

## 1.2.3 (2026-10-24)

- docs: refresh the README with the full-page workspace, Activity Bar badge/background checks, transactional updates, Cleanup tab, transitive vulnerability scanning, global vulnerability banner and solution-wide removal.
- chore: publish the refreshed documentation in the extension package.

## 1.2.2 (2026-10-24)

- fix: separate production and test TypeScript checks and add an ESLint-specific all-source tsconfig, resolving the final CI type-check failure.
- chore: align dependency versions so `npm ci` succeeds without legacy peer flags and the high-severity audit gate passes.

## 1.2.1 (2026-10-24)

- fix: update `@vscode/vsce` and pin patched `@azure/identity` / `@azure/msal-node` versions so `npm audit --audit-level=high` passes in CI.
- chore: refresh release artifacts and dependency lockfile.

## 1.2.0 (2026-10-24)

- feat: the NuGet Activity Bar entry is hidden until the workspace contains a supported .NET project (`.csproj`, `.fsproj`, or `.vbproj`) and updates when projects are added or removed.
- fix: uninstalling the last project reference now removes the matching `PackageVersion` entry from `Directory.Packages.props`, including conditional groups, so CPM files do not accumulate stale global references.
- feat: **Cleanup** tab replaces `Remove-UnusedPackages.ps1`: it reports unused `PackageVersion` entries, shows missing definitions, backs up each props file, and removes unused entries across all conditional groups.
- feat: **Remove from all projects** action on a selected package; per-project uninstall remains available from each project row. The solution-wide action confirms the affected projects and restores once afterward.
- feat: the NuGet UI now opens as a **full-page editor tab** instead of a terminal-area panel. A NuGet icon in the Activity Bar opens/reveals the tab, with a compact sidebar launcher and panel restoration after reload.
- feat: **marketplace-style UI** across Browse, Installed, Updates, Consolidate and Vulnerabilities — rounded cards, grouped framework sections, larger package icons, compact pill tabs, richer details header and theme-aware surfaces.

- security: workspace password scripts now require a trusted workspace and a machine-scoped `passwordScriptAllowlist`; `-ExecutionPolicy Bypass` was removed. The extension declares `capabilities.untrustedWorkspaces.supported: false`.
- security: `%VAR%` expansion is no longer applied to credentials from workspace `nuget.config`, preventing a repository from sending process-environment secrets to a feed it controls.
- security: feed credentials are limited to the configured source host and the service endpoints that source declares; package details are refused from untrusted hosts.
- security: project paths are validated with `path.resolve` + `realpath` + `path.relative` on every path-taking RPC, fixing Linux/macOS rejection and Windows prefix/traversal bypasses.
- security: package IDs and versions are validated before writing; `Directory.Packages.props` updates use a temp file + rename and abort if the file changed concurrently.
- fix: updating an unconditional CPM row now uses a dedicated `unconditional` scope and no longer rewrites framework-scoped version lines; consolidate checks the RPC result and removes only the consolidated framework line.
- fix: Consolidate now respects framework lines. Inconsistencies are keyed by package + condition + target framework, cards are grouped under Shared/netX, only the selected line's projects are written, and a blanket `Scope: all`/`first` consolidation of a framework-scoped package is refused.
- fix: CPM conditions on individual `PackageVersion` elements are parsed, resolved and updated; repeated conditions use the last document occurrence.
- fix: per-project updates carry `CpmCondition`/`CpmTfm`; ambiguous multi-framework updates fail with a clear message instead of guessing.
- fix: RPC timeouts post `rpc-cancel`; dotnet processes support abort/timeout and always release the global mutex.
- feat: vulnerability scan includes transitive packages from `project.assets.json`, marks them as transitive and shows the direct packages that pull them in.
- feat: the NuGet Activity Bar icon shows a badge with the number of available updates and clears it when everything is up to date.
- feat: a yellow vulnerability banner is shown across all tabs, with a direct link to the Vulnerabilities tab.
- fix: vulnerability matching is case-insensitive, returns the original package ID, and does not cache partial fetches.
- fix: the “latest” version is selected with SemVer sorting rather than registration-page order.
- fix: the Sort dropdown is now sent to the host and applied; tabs load only when activated.
- fix: bulk updates now run strictly one package at a time, restore each package before starting the next, show per-package progress, and stop at the first failure instead of racing concurrent CPM writes.
- fix: install/update failures are shown in the project row.
- chore: `.vscodeignore` excludes `.ai/` and `AGENTS.md` from the `.vsix`; release publishing is gated on a new version.
- chore: added `pretest`, declared all OpenTelemetry dependencies, removed unused `object-hash`, and corrected documentation drift.

- feat: native UI polish — Installed and Updates group packages by shared/netX with inline TFM chips and sticky group headers; every tab has a clear header, context count and primary action; Consolidate and Vulnerabilities use compact card rows with project chips; the details panel has a package header, labeled version selector and helpful empty state; the project tree shows selection counts and TFM metadata.
- feat: multi-framework CPM version management — conditional `ItemGroup`s are evaluated per project target framework (`dotnet msbuild -getProperty`) instead of using the first matching group. Negated conditions such as `!$(TargetFramework.StartsWith('net11.0'))` are evaluated and labelled distinctly (`not net11.0`), so both the net10.0 and net11.0 version lines can be shown and updated.
- feat: framework-aligned update suggestions — runtime-aligned packages (`Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`, `Microsoft.EntityFrameworkCore.*`, `Microsoft.Maui.*`, `System.*`) recommend the highest version on the TFM's major line; the overall latest version is available as a separate, explicit action.
- feat: **Update all TFMs** action in the Updates tab — updates every framework line of the selected packages, each to its own aligned version.
- feat: Installed, Updates, Consolidate and Vulnerabilities now share one per-TFM resolution, fixing inconsistent versions (for example 10.0.13 in Installed vs 11.0.0-rc in Vulnerabilities).
- feat: CPM writes are grouped per props file — a batch update across many projects sharing one `Directory.Packages.props` now performs one read/write cycle per `(package, group)` instead of one per project. All changes are verified before writing, and a failed verification leaves the file untouched.
- feat: `ConsolidateRequest` accepts `CpmCondition`/`Scope`; consolidation is scoped to the framework group selected in the UI.
- feat: `packageSourceMapping` from `nuget.config` is parsed and honoured when resolving the latest version of a package.
- feat: vulnerability results include the affected target frameworks and deduplicate identical versions across projects.
- perf: latest-version lookups are cached per package for each refresh, so a package present in several framework groups is queried once.
- perf: project discovery excludes `bin`, `obj`, `TestResults`, `packages` and `.git` by default (`excludeGlobs`).
- feat: `.slnx` workspaces activate the extension explicitly.
- test: added table-driven CPM fixture coverage for unconditional groups, distinct positive groups, shared IDs across positive groups, negated/positive framework groups, unconditional+conditional overrides, platform-specific TFMs, attribute ordering/quoting, complex `And`/`Or` conditions, unsupported conditions and document-order precedence.
- test: added host-level integration tests for `.csproj` files targeting net10.0, net11.0, both, and platform-specific TFMs.

## 1.1.3 (2026-03-26)

- fix: CPM `Directory.Packages.props` corruption when updating multiple packages in parallel — concurrent read-modify-write operations on the same file are now serialized via a per-file mutex, preventing interleaved writes that produced malformed XML (e.g. `</Project>Project>Project>` at end of file)

## 1.1.2 (2026-03-26)

- docs: Regenerated README screenshots and demo GIF at full resolution (1280×780) showcasing all features including framework badges and filter dropdowns
- chore: Added `npm run docs` script and auto-regeneration hook — screenshots and demo GIF are automatically regenerated in the background after commits that touch `src/` or `tools/mock-api.js`

## 1.1.1 (2026-03-26)

- feat: Framework-aware CPM package updates — packages scoped to a specific target framework via `<ItemGroup Condition="...">` in `Directory.Packages.props` are now shown with a framework badge in the Installed, Updates, and Consolidate tabs, and can be filtered by framework via a dropdown in the search bar
- fix: Project discovery now respects solution files — when a `.sln` or `.slnx` file is present in the workspace root, only projects referenced by those solutions are shown (instead of all `.csproj` files in the folder)
- fix: Updates, Consolidate, and Vulnerabilities tabs no longer scan projects outside the solution when the project tree panel is hidden
- fix: Updates and Consolidate tabs no longer spin indefinitely on projects without multiple target frameworks — a stable array reference is now passed to the task runner instead of a newly allocated array on every render
- fix: Version comparison now follows NuGet SemVer rules — stable releases correctly sort above pre-release versions of the same base version
- fix: CPM `Directory.Packages.props` is now parsed once per file (cached by path) during outdated package checks, preventing redundant file reads when multiple projects share the same props file
- fix: Outdated package detection now tracks the minimum installed version across projects, ensuring all projects are flagged and updated when any one of them is behind
- security: Updated `picomatch` to fix ReDoS vulnerability (GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p)

## 1.1.0 (2026-03-25)

- fix: Batch package updates no longer abort restore on the first failure — all projects are now attempted and errors are collected
- fix: Restore errors after "Update All Selected" are now shown in the UI instead of silently going to the output log only
- fix: NU1605 transitive version conflicts are now automatically resolved during restore — when a downgrade is detected, the conflicting package is updated to the required minimum version (in `Directory.Packages.props` for CPM projects, or via `dotnet add package` for direct references) and restore is retried
- refactor: `TaskExecutor` now exposes full dotnet output on failure via `DotnetError` instead of only the last partial line, enabling precise conflict parsing

## 1.0.11 (2026-03-22)

- fix: NuGet sources dropdown now correctly respects `<clear />` in workspace `nuget.config` — sources from machine/user configs and sibling workspace folders no longer bleed through
- fix: Config processing order corrected to machine → user → workspace (was reversed), matching NuGet's own merge semantics
- fix: In multi-root workspaces, all workspace folder roots are now searched for `nuget.config` instead of only the first folder (`workspaceFolders[0]`), preventing another project's sources from appearing in the dropdown
- fix: Once `<clear />` is encountered, processing stops — sources from other workspace folders processed afterward can no longer bleed in
- fix: New sources defined in the VS Code extension settings (`i-synergy-nugetpackagemanager.sources`) are now blocked when `<clear />` is present in a workspace `nuget.config`
- fix: NuGet API instance cache and credentials cache are now cleared on webview startup, ensuring sources and credentials are always resolved fresh from `nuget.config`

## 1.0.7 (2026-03-19)

- fix: Sources dropdown now updates automatically when `nuget.config` is edited — a `FileSystemWatcher` detects changes to `nuget.config` / `NuGet.Config` and triggers a configuration reload in the webview

## 1.0.6

- chore: Internal version bump; no user-facing changes documented for this release.

## 1.0.5 (2026-03-18)

- fix: Toggling prerelease no longer causes a ~15 s delay — switching prerelease no longer clears the NuGet API factory cache (only source changes do); the package cache key already includes the prerelease flag so a new state is a natural cache miss
- fix: `ClearPackageCache(id)` now correctly removes all cache variants (`id::true`, `id::false`) instead of silently failing due to a key format mismatch
- docs: Remove three settings (`defaultSource`, `pageSize`, `showOutputOnError`) from README that are defined in package.json but never read by the extension

## 1.0.4 (2026-03-18)

- security: Patched 2 high-severity vulnerabilities via npm overrides (`serialize-javascript 7.0.3`, `diff 8.0.3`)
- security: Credentials cache now expires entries after 5 minutes (TTL) to limit credential exposure window
- refactor: Removed dead `ExecuteTask()` method — all operations go through `ExecuteCommand` with real-time stdout progress
- chore: Updated `@opentelemetry/api` → 1.9, `@opentelemetry/exporter-trace-otlp-http` → 0.213, `jsdom` → 29
- chore: Enabled stricter TypeScript options (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`) and fixed all resulting errors
- ci: Build and type-check now run on every branch push and PR; publish to Marketplace runs only on push to `main`, followed by automatic git tag
- refactor: Renamed VS Code command IDs from `i-synergy-nugetpackagemanager.*` to `nugetpackage.*`
- docs: Corrected command IDs, setting keys, marketplace install command, and `.vsix` filename in README
- test: Added `host-api.test.ts` covering `getProjects`, `getConfiguration`, `getOperationProgress`, `showConfirmation`, and `getPackages`
- fix: Registered `@/` path alias for the CommonJS test runner so host-side tests resolve correctly

## 1.0.3 (2026-03-18)

## 1.0.2 (2026-03-18)

## 1.0.1 (2026-03-17)

## 1.0.0 (2026-03-17)

- feat: Animated spinner during package install/update — shows which package is being processed; spinner replaces the action button/checkbox for the duration of the operation
- feat: Tabs (Updates, Consolidate, Vulnerabilities) auto-refresh when switched to — no manual reload needed
- feat: Retry button on Browse tab when the package feed fails to load
- fix: Prerelease toggle now immediately refreshes all tabs (Updates, Consolidate, Vulnerabilities), not just Browse
- fix: Changing the prerelease setting emits the filter event immediately without waiting for the config save round-trip
- fix: `project-row` poll timer is now cleaned up via `disconnectedCallback` — no more timer leak when the row is removed from the DOM
- security: Nonce generation replaced with `globalThis.crypto.randomUUID()` — cryptographically secure and works in both Node.js and browser contexts
- security: `updateProject` now validates that the project path is inside a workspace folder and that the source URL is a valid URL — prevents path traversal and command injection
- security: Password script executor now rejects unsupported script extensions; only `.ps1`, `.bat`, `.cmd`, `.sh` are allowed
- security: `ExecuteTask` mutex acquisition is now properly awaited; added 120 s timeout with settled guard to prevent deadlocks on task hang
- security: `search-bar` sort option is validated against an explicit allowlist before use
- security: Event listeners in `main.ts` are stored as class fields and removed in `disconnectedCallback` — prevents ghost listeners on webview reload
- fix: Switching to an already-active tab no longer fires a redundant reload request
- fix: `selectedProjectPaths` is validated after project reload — stale paths that no longer exist are removed
- fix: `consolidateAll` now surfaces a per-package failure count instead of silently swallowing errors
- fix: dotnet `stderr` tail is included in error messages for actionable failure feedback
- perf: Project file parsing parallelized across all four host handlers (`getProjects`, `getOutdatedPackages`, `getInconsistentPackages`, `getVulnerablePackages`) using `Promise.allSettled`
- perf: `getPackage` calls in the Installed tab are now rate-limited to 5 concurrent requests to prevent NuGet API throttling on large solutions
- perf: `consolidateAll` runs package consolidations in parallel instead of sequentially
- ux: Tab badge counts are preserved during reload instead of disappearing while data refreshes
- ux: Removed redundant per-tab refresh buttons (Updates, Consolidate, Vulnerabilities) — tabs refresh automatically on switch
- chore: Replace custom extension icon with official NuGet logo
- chore: RPC timeout increased from 30 s to 120 s to handle large solution restores reliably
- refactor: `executeAddPackage` and `executeRemovePackage` migrated from `vscode.Task` to `child_process.spawn` for stdout capture and real-time progress reporting

## 1.0.2 (2026-02-20)

- feat: Release script with dry-run mode and changelog automation (`tools/release.mjs`)
- feat: GitHub Actions `workflow_dispatch` trigger for one-click releases via GitHub UI
- fix: Lit component tests failing with `cssText` error (JSDOM require hook for `.css.ts` modules)
- fix: NuGetApiFactory and SearchBar tests aligned with current source code
- test: 313 tests passing (up from 197)
- chore: CI pipeline uses Node LTS, release job publishes directly

## 1.0.1 (2026-02-19)

- fix: Tab sub-views (Updates, Consolidate, Vulnerabilities) now load reliably — `setTab()` was
  calling `querySelector()` synchronously before Lit rendered the new element (microtask timing bug)
- feat: Tab badges showing result counts on Updates, Consolidate, and Vulnerabilities tabs
- fix: Selected package row now uses the active selection highlight color instead of the inactive one
- ux: Search bar is now hidden on the Updates, Consolidate, and Vulnerabilities tabs where it is not relevant
- breaking: Renamed commands `I-Synergy.NugetPackageManager.openSettings` and `I-Synergy.NugetPackageManager.reportProblem`
  to `nugetPackageManager.openSettings` and `nugetPackageManager.reportProblem` for consistency with other command IDs
- chore: Moved screenshot tooling from `screenshot-harness/` to `tools/`

## 1.0.0 (2026-02-18)

- feat: Rebrand from "NuGet Gallery" to **NuGet Package Manager** with new extension ID
- feat: Typed RPC layer with `Result<T>` for host-webview communication
- feat: UI migration from FAST Element to Lit (LitElement)
- feat: Vulnerability scanning view with severity badges and advisory links
- feat: Project tree with checkbox-based multi-project selection
- feat: Confirmation dialogs for destructive actions (uninstall, update all, consolidate)
- feat: Keyboard navigation and ARIA accessibility for all interactive elements
- feat: Central Package Management (CPM) support
- feat: NuGet.config authentication with password script decryption
- feat: Inline package version decorations in project files
- feat: Prerelease version support, pinned versions (`[x.x.x]`)
- feat: Multi-source search with "All" option
- feat: Status bar loading indicator
- refactor: Complete architecture overhaul (typed RPC replacing untyped messages)
- refactor: Resizable 3-pane layout with Split.js
- test: 202 tests (unit + component tests for all handlers and UI components)
- chore: GitHub Actions CI/CD pipeline with automatic Marketplace publish

### Credits

This extension builds upon:

- [pcislo/vscode-nuget-gallery](https://github.com/pcislo/vscode-nuget-gallery) by [Patryk Cislo](https://github.com/pcislo) (original author)
- [shis91/vscode-nuget-gallery](https://github.com/shis91/vscode-nuget-gallery) by [shis91](https://github.com/shis91) (major feature additions, CPM, authentication, test infrastructure)
