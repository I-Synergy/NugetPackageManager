# Local tools: ignore cached/scratch manifests
Status: DONE
Started: 2026-11-04
Plan: `.ai/plans/local-tools-exclusions.md`

## Steps
- [x] Step 1: hidden-directory rule in the core locator (covers the whole `.ai` folder)
- [x] Step 2: extract the exclusion helpers and filter manifests in the host adapter
- [x] Step 3: tests + docs (CHANGELOG, README Repo tools bullet)
- [x] Step 4: verification (dotnet tests, typecheck, lint, focused TS suites, quality gate)

## Notes

### Why the cached manifest appeared
`LocalToolManifestLocator.FindManifests` walks every workspace root and only skipped
`bin`/`obj`/`node_modules`/`.git`/`.vs`, so the cached checkout under
`.ai/tmp/catalog-cache/maui-labs-main-260043eb/` was walked and its manifest reported.

### Changes
- **Core** (`LocalToolManifestLocator.cs`): `CollectManifests` no longer descends into any
  dot-prefixed directory (the direct `<dir>/.config/dotnet-tools.json` check still runs first, so a
  real `.config` is found but never traversed). `CollectFromProjectsUpwards` uses `FindOwningRoot` +
  `IsInHiddenDirectory` and skips a candidate whose owner directory sits under a hidden segment,
  while still walking up so a root manifest is reported. The rule matches project discovery
  ("a hidden directory segment is internal"), so the whole `.ai` tree is ignored.
- **Host**: `isInternalExcludedPath` and `applyExcludeGlobs` moved verbatim to
  `utilities/workspace-exclusions.ts` (imported back by `host-api.ts`, no behaviour change).
  `ReadLocalToolsAsync` filters core results with both, matched against the manifest's **owner
  directory** (the folder containing `.config`), and logs the dropped count. Matching the owner
  directory is required because the manifest path always contains the hidden `.config` segment, so
  the default `**/.*/**` pattern would otherwise drop every manifest.
- **Docs**: CHANGELOG fix entry; README Repo tools bullet.

### Tests
- Core: `.ai/tmp/catalog-cache/<repo>` manifest ignored while root and `src` manifests are kept;
  other hidden root folders ignored; a project under a hidden ancestor adds nothing while the root
  manifest is still found.
- Host: hidden-folder manifest dropped, configured `excludeGlobs` applied to the owner directory,
  and the real default `excludeGlobs` list still keeps root/`src` manifests.

### Verification
- `dotnet build NugetPackageManager.slnx -c Release` — success, 0 warnings/errors.
- `dotnet test` filtered: 17 (`Core.Tests`) + 38 (`Core.Workspace.Tests`) passed.
- `npm run typecheck`, `npm run lint` — clean.
- Focused TS: `local-tools.test.js` (27) + `toolchain-view.test.js` (16) — 43 passed.
- `npm run quality` — **PASS, 8/8** (57 + 108 + 225 C# tests, 525 TS tests).

### Local test build
`releases/nugetpackagemanager-2026.11103.12309.vsix` (version `2026.11103.12309`), built with the
derived UTC build number; `package.json` / `package-lock.json` restored to `2.2.0` afterwards.
