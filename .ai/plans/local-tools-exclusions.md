# Local tools: stop reporting manifests from cached/scratch folders

Status: APPROVED (answer: ignore the whole `.ai` folder, kept via the hidden-directory rule)
Created: 2026-11-04
Author: Reasonix Code
Report: `.ai/tmp/catalog-cache/maui-labs-main-260043eb/.config/dotnet-tools.json` appears in Toolchain → Repo tools

## Why it happens

`LocalToolManifestLocator.FindManifests` walks each workspace root breadth-first and only skips
`bin`, `obj`, `node_modules`, `.git`, `.vs` (`LocalToolManifestLocator.cs:22`). `.ai/tmp` is a plain
(non-reparse) directory, so the cached checkout under `.ai/tmp/catalog-cache/...` is walked and its
manifest is reported.

The rest of the extension already treats hidden directories as internal:
`isInternalExcludedPath` in `host-api.ts` drops any project path with a hidden directory segment, and
the default `nugetpackagemanager.excludeGlobs` starts with `**/.*/**`. Local-tool discovery simply
never picked those rules up.

## Fix

### 1. Core walk (the actual bug)

`src/NugetPackageManager.Core.Workspace/Tools/LocalToolManifestLocator.cs`

- Do not descend into directories whose name starts with `.` during `CollectManifests`. The direct
  candidate check (`<directory>/.config/dotnet-tools.json`) happens before descending, so a
  legitimate `.config` is still found; `.config` itself is never traversed.
- In `CollectFromProjectsUpwards`, reject a candidate whose ancestor chain **above `.config`**
  contains a hidden segment (walk-up from a project inside a scratch folder).
- Keep the existing `bin`/`obj`/`node_modules`/`.git`/`.vs` skips and the reparse-point skip.

### 2. Host: honour the configured excludes

- Extract `isInternalExcludedPath` and `applyExcludeGlobs` from `host-api.ts` into a new
  `src/NugetPackageManager.VSCode.Host/utilities/workspace-exclusions.ts` and import them from
  `host-api.ts` (pure move, no behaviour change; avoids an import cycle with `local-tools.ts`).
- In `utilities/local-tools.ts`, filter the manifests returned by the core: drop a manifest when its
  **owner directory** — the directory that contains `.config` — is excluded by
  `isInternalExcludedPath` or by `getSetting<string[]>("excludeGlobs", [])`.
  The owner directory, not the manifest path, is matched on purpose: the manifest path always
  contains the hidden `.config` segment, so the default `**/.*/**` pattern would otherwise exclude
  every manifest.
- Log how many manifests were dropped (`Logger.debug`), and keep the empty state unchanged.

No contract change (`excludeGlobs` stays a host-side setting), no change to the update path, and no
new webview work.

## Steps

- [ ] Step 1: hidden-directory rule in the core locator + project walk-up guard
- [ ] Step 2: extract the exclusion helpers and filter manifests in the host adapter
- [ ] Step 3: tests + docs (CHANGELOG, README Repo tools bullet)

## Verification

- `dotnet test tests/NugetPackageManager.Core.Workspace.Tests/... --filter LocalToolManifestLocator`
  — new cases: a `.ai/tmp/<repo>/.config` manifest is not reported; a root or `src/` manifest next to
  it still is; a project under a hidden ancestor yields nothing.
- `npm run typecheck`, `npm run lint`, focused `local-tools.test.js` and `toolchain-view.test.js`
  (unchanged render path must stay green).
- `npm run quality` if the full gate is required before release.

## Out of scope

- Reading `.gitignore` (the configured `excludeGlobs` remains the user-facing control).
- Changing what counts as a tool, or any update/restore behaviour.
