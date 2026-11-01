# TheNugetPackageManager — Session Context

**Last Updated:** 2026-10-30
**Project Version:** 2.2.0
**Branch:** development/main
**Written By:** Reasonix Code
**Next Session May Use:** Any

---

## Project Overview

**Extension ID:** `I-Synergy.nugetpackagemanager`
**Purpose:** VS Code extension for browsing, installing, updating, and auditing NuGet packages across .NET projects without leaving the editor.
**Stack:** TypeScript, Node.js (host), Lit (webview), dotnet CLI, typed RPC over postMessage
**Phase:** Active development — post-fork hardening

---

## Recent Work (this session and last)

### In progress: remaining Sonar findings — PR #41 (2026-10-30)
- Follow-up to PR #40: 17 main-branch findings cleared; PR #41 → `main`: https://github.com/I-Synergy/NugetPackageManager/pull/41

### In progress: SonarCloud remediation + automatic releases — PR #40 (2026-10-30)
- Branch `development/main` pushed; PR #40 → `main`: https://github.com/I-Synergy/NugetPackageManager/pull/40
- Plan: `.ai/plans/sonar-remediation.md`; progress: `.ai/progress/sonar-remediation.md`
- Sonar scope: `.sonarcloud.properties` now drives automatic analysis (`.ai/**` and `docs/**` excluded, `src/**`/`tools/**`/`.github/**` kept). `sonar-project.properties` and the token-based scan step were removed.
- Product findings: all 269 scoped issues addressed, including 13 vulnerabilities; cognitive-complexity hotspots were refactored into helpers, not suppressed. `eslint src` is clean (0 errors, 0 warnings).
- CI hardening: `npm ci --ignore-scripts`, no `npx`, pinned `softprops/action-gh-release`.
- Releases: `release.yml` now derives `YYYY.1MMdd.1HHmm` from the UTC build time, sets it for the build only, runs the quality gate, publishes, tags without `v`, and creates generated notes. `tools/release.mjs`, `RELEASE_NOTES.md` and the manual release workflow were removed.
- Verification: `npm run quality` PASS (434 tests), `.ai/tests/run-all-tests.sh` 11/11, `git diff --check` clean.

### Completed: quality gate (2026-10-30)
- Plan: `.ai/plans/quality-gate.md`; progress: `.ai/progress/quality-gate.md`
- Added `npm run quality` (`tools/quality-gate.mjs`): build, ESLint + SonarJS, `tsc --noEmit`, tests, `npm audit --audit-level=high`; `npm run quality:coverage` also writes `coverage/lcov.info`.
- Added `.github/workflows/quality-gate.yml`, `sonar-project.properties` (`sonar.projectKey=I-Synergy_NugetPackageManager`, org `i-synergy`) and the `Quality Gate` wait flag. The Sonar scan step is skipped when `SONAR_TOKEN` is absent.
- Coverage uses `@vscode/test-cli --coverage` (c8) — a bare `c8` wrapper around `vscode-test` reports 0% because the Electron extension host does not inherit `NODE_V8_COVERAGE`.
- Cleared the SonarJS correctness/security findings; 72 maintainability warnings remain (complexity, nesting, template literals, two duplicate test helpers, five super-linear regexes).
- README badges: CI, quality gate, SonarCloud (alert/security/maintainability/reliability), Marketplace version/installs/downloads/rating, license, VS Code.
- Verification: `npm run quality` PASS (434 tests), `npm run test:coverage` produces lcov at ~68% statements, `git diff --check` clean. Committed locally (`chore: add quality gate with SonarJS, coverage and SonarCloud`), not pushed.
- Follow-up: the SonarCloud project `I-Synergy_NugetPackageManager` now exists; add the `SONAR_TOKEN` repository secret so the scan runs and the badges compute.

### Completed: batch preflight, single restore, attributed retry, live progress + cancel (2026-10-28)
- Plan: `.ai/plans/batch-preflight-retry-progress.md`; progress: `.ai/completed/batch-preflight-retry-progress.md`
- `checkBatchUpdateAsync` → `findBatchUpdateConflictsAsync` checks the whole selection before a write: the target version's own dependency ranges against the effective graph (installed versions + selected overrides) and the ranges installed packages declare on the selected packages (skipping blockers that are in the batch). Needs `obj/project.assets.json`; otherwise restore stays the authority.
- `updates-view` runs the preflight before a multi-row update, shows the conflicts in a confirmation dialog and skips those rows when the user proceeds.
- Non-CPM `dotnet add` calls inside a transactional batch now pass `--no-restore`; exactly one `dotnet restore` covers the batch.
- A failed restore is attributed back to batch rows (`attributeRestoreConflicts` → `BatchUpdateResponse.ConflictingPackages`); the tab offers "Retry without …" once.
- `TaskExecutor.ExecuteCommandAsync` accepts an `onProgress` callback; `restoreProjectsInternalAsync` forwards per-project `dotnet` stages, which the batch maps into its 80–95 % band.
- `BatchUpdateResponse.Cancelled` + `onStarted(jobId)` in `src/NugetPackageManager.VSCode.Webview/jobs.ts` back a **Cancel** button in the Updates progress banner (`cancelJobAsync`), which rolls back.
- Cancel is wired into every job-triggering UI: `project-row` (busy row), `consolidate-view` (per-card), `cleanup-view`, and `packages-view` "remove from all projects" (stops the per-project loop). Each runner reports cancellation with a message saying what was rolled back or left applied.
- Tests: **434 passing**; `npm run esbuild`, `npm run lint`, `npm run test-compile` clean.
- Version bumped 2.1.0 → **2.2.0** (package.json/package-lock, CHANGELOG, RELEASE_NOTES);
  committed on `feat/update-jobs-and-cancel` with a PR to `main`.

### Completed: every long mutation is a host job (2026-10-28)
- Plan: `.ai/plans/mutation-jobs-project-consolidate-cleanup.md`; progress: `.ai/completed/mutation-jobs-project-consolidate-cleanup.md`
- Builds on the detach fix: `updateProjectAsync`, `consolidatePackagesAsync` and `cleanupUnusedPackagesAsync` no longer hold a request open for the length of a repo-wide write/restore, so a slow run neither times out nor loses its result.
- `src/NugetPackageManager.VSCode.Host/utilities/operation-jobs.ts` replaces `batch-update-jobs.ts`: a generic `JobRegistry<T>` (bounded retention, running jobs never pruned, explicit cancel wins over the abort failure) plus `OperationJobs` for `batchUpdate`, `projectUpdate`, `consolidate` and `cleanup`.
- RPC surface is now `startBatchUpdateAsync` / `startProjectUpdateAsync` / `startConsolidateAsync` / `startCleanupAsync` → `{ JobId }`, `getJobAsync` → a `GetJobResponse` union discriminated by `Kind`, and `cancelJobAsync`. The legacy single-call RPCs remain and delegate to the same implementations.
- Host implementations moved to `runBatchUpdateAsync`, `runProjectUpdateAsync`, `runConsolidateAsync`, `runCleanupAsync` with stage/percent reporting.
- `src/NugetPackageManager.VSCode.Webview/jobs.ts` adds `waitForJobAsync` (poll 250 ms, optional `AbortSignal`, no stray timers) and typed runners; `updates-view`, `project-row`, `packages-view`, `consolidate-view` and `cleanup-view` use them.
- Tests: **421 passing**; `npm run esbuild`, `npm run lint`, `npm run test-compile` clean.
- Not converted: `restoreProjectsAsync` (never writes versions; only its result can be lost) and `getOutdatedPackagesAsync` (already uses `ScanProgress` + `ScanId`).

### Completed: RPC deadline detach + job-based batch updates (2026-10-28)
- Plan: `.ai/plans/rpc-timeout-detach-and-batch-jobs.md`; progress: `.ai/completed/rpc-timeout-detach-and-batch-jobs.md`
- Root cause of the "slow update reverted my packages" reports: `RPC_TIMEOUT_MS` (120 s) was a client deadline on calls whose runtime scales with the repo, and the timeout handler posted `rpc-cancel`. The host aborted the request signal, and `batchUpdatePackagesAsync` / `updateProjectAsync` treated that abort as a failure and ran `rollbackFilesAsync` over files they had just written.
- `rpc-client.ts`: the deadline now drops the pending call and fails with "still running in the extension host" — it never sends `rpc-cancel`. Explicit cancellation via `AbortSignal` still cancels. Slow work is no longer reverted for any method, including single-package `updateProjectAsync`.
- New job registry (same bounded/prunable idiom as `ScanProgress`) + RPCs `startBatchUpdateAsync`, `getBatchUpdateJobAsync`, `cancelBatchUpdateAsync`. The job runs detached from the request signal, streams stage/percent, and only one job may run at a time. **Superseded by the entry above**: the registry is now `operation-jobs.ts` and the batch-specific get/cancel were replaced by `getJobAsync` / `cancelJobAsync`.
- `updates-view` starts a job and polls it (immediate + 250 ms) with a determinate progress bar; polling stops on completion, error, cancel and disconnect.
- A cancel now rolls back the versions already written (`transactionFailed = transactional` when the signal aborted).
- Tests: **410 passing**; `npm run esbuild`, `npm run lint`, `npm run test-compile` clean.
- Follow-up: convert `updateProjectAsync`, `consolidatePackagesAsync` and `cleanupUnusedPackagesAsync` to the same job registry — they currently inherit only the detach fix, so a client that timed out loses the final outcome until it refreshes.

### Completed: Prerelease-aware update badge + live scan progress (2026-10-26)
- Plan: `.ai/plans/prerelease-badge-and-scan-progress.md`; progress: `.ai/completed/prerelease-badge-and-scan-progress.md`
- Root cause of the stale badge: `UpdatePackagesFiltersAsync` never refreshed the update count on a Prerelease change. Only a mounted `updates-view` reported `count-changed`, and no scan ever called `updateBadgeAsync` for the Activity Bar badge.
- `packages-view` now clears the count immediately (`…` in the tab badge), re-scans when no Updates tab is mounted, and keeps the tree badge in sync through a new `badge-changed` event (count + blocked count).
- New `ScanId` on `GetOutdatedPackagesRequest` + `getOutdatedScanProgressAsync` RPC backed by `src/NugetPackageManager.VSCode.Host/utilities/scan-progress.ts`. The host reports resolving sources → parsing projects (n/N) → latest versions (n/N) → dependency constraints (n/N) → preparing results.
- `updates-view` polls progress every 400 ms while loading and renders the stage, item counts and a determinate progress bar; polling stops on completion, error, cancellation and disconnect.
- Tests: **395 passing**; `npm run esbuild` and `npm run lint` clean.
- Version bumped 2.0.0 → **2.1.0**; `CHANGELOG.md` and `RELEASE_NOTES.md` updated; local test build at
  `releases/nugetpackagemanager-2.1.0.vsix` (24 files, 8.26 MB, manifest 2.1.0). Not committed.

### Completed: Rename to TheNugetPackageManager + faster Updates (2026-10-26)
- Plan: `.ai/plans/rename-and-faster-updates.md`; progress: `.ai/completed/rename-and-faster-updates.md`
- Extension identity renamed to `nugetpackagemanager` / `TheNugetPackageManager`; repository URLs now point at `I-Synergy/TheNugetPackageManager`
- All internal IDs migrated: commands, webview panel, views, settings (`nugetpackagemanager.*`), global state, telemetry
- Legacy namespace removed completely: no `i-synergy-nugetpackagemanager.*` settings, no `nugetpackage.*` command aliases, no legacy panel ID/activation event; existing settings/keybindings must be recreated
- Updates warm start: last scan persisted in `workspaceState`, painted immediately, live refresh in the background, selections preserved
- NuGet metadata: registration dependency groups reused; on-disk HTTP cache (30 min, `globalStorage/nuget-http`); concurrency configurable (`updateCheckConcurrency`, default 8)
- Verification: `npm test` — **388 passing**, lint/esbuild clean, VSIX `nugetpackagemanager-1.2.14.vsix` inspected
- Deferred: persisting TFM resolution (only helps unrestored trees; current workspaces resolve from XML/assets)

### Prepared: 2.0.0 local release (2026-10-26)
- Version bumped 1.2.14 → **2.0.0** (breaking rename + dependency-aware updates) in `package.json`/`package-lock.json`
- User-facing name is **NuGet Package Manager** (displayName, command titles, settings title, panel/HTML title, output channel, README); machine identity stays `nugetpackagemanager` / `theNuGetPackageManager.*`
- `CHANGELOG.md` now has an empty `## Unreleased` followed by `## 2.0.0 (2026-10-26)`; `RELEASE_NOTES.md` rewritten for the GitHub Release
- `.vscodeignore` excludes `docs/images/social-preview.png` (GitHub-only asset, keeps the VSIX lean)
- Built `releases/nugetpackagemanager-2.0.0.vsix` (24 files, 8.25 MB); manifest: Id `nugetpackagemanager`, Version `2.0.0`, Publisher `I-Synergy`
- Verification: `npm run package` clean, `npm test` — **385 passing**
- Nothing committed, tagged, pushed or published; the user commits and releases

### Completed: Folder-rename follow-up (2026-10-26)
- Local folder renamed to `TheNugetPackageManager` and the VS Code workspace reimported
- Regenerated `.claude|.github|.reasonix/{skills,agents}` junctions; they still pointed at `I-Synergy.NugetPackageManager`
- `sync-skills.py` now detects dangling junctions with `os.path.lexists` and repairs them (verified in a temp sandbox); previously it reported FAIL and left them broken
- `.claude/settings.json` docs hook no longer hardcodes the old absolute path (uses `${CLAUDE_PROJECT_DIR:-.}`)
- `origin` now points at `https://github.com/I-Synergy/NugetPackageManager.git` (the repository was renamed twice; GitHub 301s the older URLs)
- Verification: `npm run esbuild`, `npm run lint` clean; `npm test` — **385 passing**

### Completed: NU1107 conflict handling and dependency-aware updates (2026-10-26)
- Plan: `.ai/plans/nuget-version-conflict-handling.md`; progress: `.ai/completed/nuget-version-conflict-handling.md`
- Restore diagnostics parse `NU1107`/`NU1605`/`NU1608`/`NU1102`/`NU1109` and report the constraint chain
- Single-package updates snapshot and roll back on restore failure; restore-only, never `dotnet build` (regression test)
- Updates caps suggestions to versions accepted by directly installed dependencies; blocked versions are visible in a **Dependency conflicts** section
- Not committed yet; the working tree also contains the rename changes.

### Completed: Consolidation respects framework lines (2026-10-24)
- Plan: `.ai/plans/consolidate-multi-framework.md`; progress: `.ai/completed/consolidate-multi-framework.md`
- Host groups inconsistencies by `packageId + condition + TFM`; no cross-framework collapse
- Consolidate cards grouped under Shared/netX; each card sends only its own line's projects/condition
- `Consolidate all` is sequential and only for visible cards; blanket `Scope: all`/`first` is refused
- Tests: **321 passing**, including grouping, per-line write scope and same-condition cards

### Completed: Native UI polish (2026-10-24)
- Progress: `.ai/completed/native-ui-polish.md`; design: `docs/design/native.html`
- Review comparison: native polish vs marketplace style; native direction chosen
- Installed/Updates grouped by Shared/netX with inline TFM chips and sticky group headers
- Every tab now has a list header, context count and primary action
- Consolidate and Vulnerabilities use card rows with chips, severity and project metadata
- Details panel: package header (verified/TFM/source), labeled version selector, empty state
- Project tree: selected/total count, TFM metadata; search bar spacing and source label clarified
- Tests: **315 passing**; `npm run lint`/`npm run esbuild` clean; screenshots regenerated

### Completed: Whole-application review remediation (2026-10-24)
- Progress: `.ai/completed/review-remediation.md`; plan: `.ai/plans/whole-application-review-remediation.md`
- All 4 Blockers fixed: workspace trust + password-script allowlist; unconditional CPM scope; realpath-based path containment on all path RPCs; no `%VAR%` expansion for workspace `nuget.config`
- Security hardening: credential origin scoping, package/version validation before XML writes, atomic CPM writes, vulnerability key normalization + complete-only cache, SemVer latest selection, CSP, opt-in telemetry, `openExternal` scheme allowlist
- CPM correctness: `unconditional` scope, consolidate result handling/row keys, per-project TFM context, element-level `PackageVersion` conditions, document-order precedence
- Reliability/UI: RPC timeout posts `rpc-cancel`, dotnet abort/timeout, lazy tabs, visible update failures, working Sort, project-tree selection preservation, dialog focus/Escape
- Packaging/release: `.vscodeignore` excludes `.ai`/`.reasonix`/`AGENTS.md`; publish gated on a new version; `pretest`; OTel deps declared; dead cache/settings/type removed
- Verification: `npm run esbuild`, `npm run lint`, `npm test` — **313 passing**; framework e2e unchanged; `vsce ls` shows 18 files with no agent content; `.ai/tests` 11/11
- Residual follow-ups are listed in `.ai/completed/review-remediation.md` (flaky test timers, some logger-only assertions, full Tab trap, remaining component/host coverage)

### Completed: Whole-application review (2026-10-24)
- Report: `.ai/analysis/whole-application-review-2026-10-24.md`
- 4 parallel reviewers (architecture, security, web UI, tests/maintainability) + direct verification of every Blocker
- Result: 4 Blockers, 16 Majors, 20 Minors; 277 tests still passing, tsc/lint clean
- Blockers: workspace-controlled `passwordScriptPath` RCE; unconditional CPM row sends `Scope:"all"` and rewrites framework lines; path containment broken on Linux/macOS and bypassable on Windows; workspace `nuget.config` `%VAR%` credential expansion to attacker feed
- Highest-priority Majors: consolidate ignores RPC result and removes all rows by Id; RPC timeout does not cancel host work; per-project update loses TFM context; element-level `PackageVersion` conditions ignored; unvalidated version written into XML; vulnerability key casing + partial cache; latest-version relies on feed ordering; Basic auth forwarded to feed-supplied URLs; `.vscodeignore` ships 12 MB `.ai/`; publish job runs on every `main` push
- No code was changed by the review

### Completed: AI template upgrade — `.claude/` → `.ai/` (2026-10-24)
- Migrated all AI context to `.ai/` with the template migration script; `.claude/` now holds only `settings.json` + `settings.local.json` (plus generated junctions)
- Applied the updated template: `.ai/agents` (9), `.ai/skills` (80), `.ai/patterns`, `.ai/reference`, `.ai/checklists`, `.ai/scripts`, `.ai/tests`
- Rewrote `AGENTS.md` for this TypeScript/VS Code extension project; `CLAUDE.md` remains the detailed engineering guide and points to `AGENTS.md`
- Updated `.github/copilot-instructions.md` with the `.ai/session-context.md` convention and session-memory section
- `sync-skills.py` created junctions: `.claude|.github|.reasonix/{skills,agents}` → `.ai/{skills,agents}` (gitignored)
- `.claude/settings.json`: `.ai/plans` plansDirectory, SessionStart sync + session-context hooks, skill/agent sync hooks, npm esbuild/lint Stop hook (the .NET build hook was removed)
- Validation: `.ai/tests/run-all-tests.sh` — **11/11 suites passed**
- Project-owned content preserved: `session-context`, `project/`, `plans/`, `progress/`, `completed/`, `analysis/`

### Completed: Multi-framework CPM version management (2026-10-24)
- New `cpm-condition.ts`: parses/evaluates MSBuild conditions (`!`, `StartsWith/EndsWith/Contains`, `==`/`!=`, `And`/`Or`, parentheses); labels negation distinctly (`not net11.0`)
- New `project-framework-resolver.ts`: resolves real project TFMs via `dotnet msbuild -getProperty`, with mtime cache, XML fallback, manual overrides and a 16-way evaluation limiter
- `CpmResolver`: `ResolveVersions` (one version line per condition), `UpdateCpmVersionsAsync` (single read/write per props file, verification before write, group/all/first scopes)
- `host-api.ts`: Installed/Updates/Consolidate/Vulnerabilities now share per-TFM resolution; aligned latest version per TFM major; deduplicated NuGet lookups; `packageSourceMapping`-aware source selection; bin/obj exclusions
- UI: per-TFM rows and framework filter, **Update all TFMs**, explicit latest-overall action, TFM badges for vulnerabilities
- Tests: 277 passing; fixtures in `src/NugetPackageManager.VSCode.Host/utilities/__fixtures__/cpm` and `.../projects`; host integration covers net10/net11/multi/platform projects
- Verified against `D:\Projects\I-Synergy\I-Synergy.Framework`: 69 unconditional + 2×31 conditional groups, net10 → 10.0.13, net11 → 11.0.0-rc.2, scoped writes only touch the addressed `ItemGroup`
- Screenshots: `docs/images/screenshot-{installed,updates}-frameworks.png`, `...-net9.png`

### Completed: Framework-aware CPM updates (feature/framework-aware-cpm-updates)
- `CpmResolver`: new `CpmFrameworkEntry`/`CpmPackageMap` types; `GetFrameworkPackageMapAsync` reads conditional ItemGroups; `UpdatePackageVersionAsync` accepts optional `condition` for scoped regex updates
- `OutdatedPackage`/`OutdatedPackageViewModel`: optional `CpmCondition`/`CpmFramework` fields
- `BatchUpdateRequest.Updates`: optional `CpmCondition` field forwarded to `CpmResolver.UpdatePackageVersionAsync`
- `host-api.ts`: composite key `"packageId\0condition"` in `getOutdatedPackagesAsync`; per-project `CpmPackageMap` cached; `CpmCondition`/`CpmFramework` emitted on `OutdatedPackage`
- `updates-view.ts`: `_selectedFramework` state; `frameworkOptions` getter (empty → no selector shown); `visiblePackages` filters by framework + text query; `toggleSelectAll`/`allVisibleSelected` scoped to visible; framework `<select>` dropdown (only when conditional packages exist); framework badge on each row in "All" view; `CpmCondition` passed in update calls; reset on load
- Tests: 9 new tests in `cpm-resolver.test.ts` covering `GetFrameworkPackageMapAsync` + condition-scoped updates; 226 total passing

### Completed: NU1605 Batch Update Fixes (v1.1.0, released)
- `DotnetError` class with `output: string` carrying full stdout
- `restoreProjectsAsync`: per-project error isolation, collects all failures
- `restoreWithConflictResolutionAsync`: auto-fixes NU1605 transitive conflicts, retries (max 2 attempts)
- `parseNu1605Conflicts`: regex parser for NU1605 error lines

### Completed: Real-time Progress Bar
- Migrated `executeAddPackage` / `executeRemovePackage` from `vscode.Task` → `child_process.spawn`
- `TaskExecutor.ExecuteCommand` parses dotnet stdout for stage keywords, stores in `Map<operationId, OperationProgress>`
- Added `getOperationProgress` RPC method; webview polls every 300ms
- `project-row` shows animated progress bar (stage label + fill bar) during operations
- Polling stopped in `disconnectedCallback` and when `Active=false`

### Completed: Tab Auto-refresh
- Updates, Consolidate, Vulnerabilities tabs auto-refresh when switched to
- `setTab()` guards with `if (tab === this.activeTab) return` to avoid redundant reloads
- Removed per-tab refresh buttons (they were redundant)

### Completed: Security Hardening (commit 537a330)
- `nonce.ts`: `globalThis.crypto.randomUUID()` — no Node.js import, works in browser too
- `host-api.ts`: workspace path validation + URL validation in `updateProject`
- `password-script-executor.ts`: explicit allowlist for `.ps1/.bat/.cmd/.sh`, reject others
- `task-executor.ts`: proper `await mutex.acquire()`, 120s timeout, `clearTimeout` on success
- `project-row.ts`: stop polling on `Active=false`, cleanup in `disconnectedCallback`
- `search-bar.ts`: sort option whitelist validation
- `main.ts`: stored event listeners + `disconnectedCallback` cleanup

### Completed: Documentation & Assets
- Official NuGet logo as extension icon (`docs/images/icon.png`, `docs/raw/icon.svg`)
- README updated with Real-time Progress feature, auto-refresh notes, retry button
- CHANGELOG.md updated with full Unreleased section

### Completed: Dependency Updates
- Updated 16 packages (skipped eslint 9→10, opentelemetry version pin)

---

## Established Patterns

### RPC Pattern
All host↔webview calls use typed RPC (`src/NugetPackageManager.VSCode.Common/rpc/types.ts`). Every method returns `Result<T>`. Add new methods by:
1. Adding request/response types to `types.ts`
2. Adding the method signature to `HostAPI` interface in `types.ts`
3. Implementing in `host-api.ts`
4. Calling via `hostApi.methodName(request)` from webview

### Error Handling
RPC methods use `ok(value)` / `fail(message)` helpers. Never throw — always return `fail()`.

### Progress Operations
For long-running operations:
1. Generate `operationId = \`${type}-${packageId}-${Date.now()}\``
2. Pass to `TaskExecutor.ExecuteCommand`
3. Start polling `getOperationProgress` every 300ms
4. Stop polling when `Active=false` or component disconnected

---

## Known Issues / Decisions

### RPC Timeout
Increased from 30s → 120s (`RPC_TIMEOUT_MS` in `types.ts`) to handle large solution restores. This is intentional.

### OpenTelemetry
Used for anonymous usage telemetry (operation counts, error rates). Connects to an OTLP endpoint configured in `host-api.ts`. No PII is sent. The endpoint is hardcoded to the project's own collector.

### ESLint Version
Staying on ESLint 9.x — ESLint 10 has breaking config changes that aren't worth migrating now.

### src/NugetPackageManager.VSCode.Common/ Isomorphism
Files in `src/NugetPackageManager.VSCode.Common/` are bundled into BOTH the host (Node.js) and web (browser) bundles. They must not import Node.js-only modules. Use `globalThis.crypto` instead of `import { randomBytes } from "crypto"`.

---

## Open Plan

### Completed: Sequential transactional updates (2026-10-24)
- `Update all` / `Update all TFMs` no longer use `Promise.allSettled`
- Each package is written, restored and verified before the next one starts
- Per-package progress in the status line; first failure stops the batch and keeps the failed row
- **321 tests passing**; VSIX repackaged


### Completed: NuGet view visibility (2026-10-24)
- Activity Bar entry is guarded by `nuget.hasSupportedProjects`
- Context is set from discovered `.csproj`/`.fsproj`/`.vbproj` files and refreshed on folder/project changes
- **321 tests passing**; VSIX repackaged


### Completed: Full-page marketplace UI (2026-10-24)
- Plan `.ai/plans/full-page-marketplace.md`; progress `.ai/completed/full-page-marketplace.md`
- UI moved from the terminal/panel view to a full-page `WebviewPanel`; activity-bar icon opens it
- Sidebar container is a compact launcher; panel restores after reload via `WebviewPanelSerializer`
- Marketplace card language applied across all tabs and the details panel
- **321 tests passing**; VSIX repackaged and force-installed


None. The review remediation and native UI polish plans are implemented; residual follow-ups
are recorded in `.ai/completed/review-remediation.md`. The `.claude/` → `.ai/` migration plan
was completed on 2026-10-24 and archived to `.ai/completed/`.

---

## Next Session Checklist

1. **If releasing**: Update `package.json` version, run `npm run package`, verify `.vsix`
2. **If adding RPC method**: types.ts → host-api.ts → webview call
3. **If editing `src/NugetPackageManager.VSCode.Common/`**: Ensure no Node.js-only imports (test with `npm run esbuild`)
4. **Before any commit**: `npm run quality` (build + lint with SonarJS + type check + tests + audit; 0 errors required)
5. **After changing AI context**: `bash .ai/tests/run-all-tests.sh` (11 suites) and regenerate junctions with `python .ai/scripts/sync-skills.py`
