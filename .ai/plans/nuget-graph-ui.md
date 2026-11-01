# Plan: Resolve NuGet graph problems in the UI

**Status:** IMPLEMENTED — 2026-10-31
**Date:** 2026-10-31
**Problems to solve**
1. Packages referenced **directly** although they only arrive **transitively** (someone ran
   `dotnet add package` on a transitive dependency, or a parent package later started carrying it).
   Today nothing detects this; the reference silently pins a version and hides parent updates.
2. **Version conflicts** (NU1107 / NU1605 / NU1608 / NU1109). Today they are parsed and shown, and
   only NU1605 is auto-fixed during a restore; the user cannot act on the conflict from the UI.

Both should be resolvable without hand-editing `.csproj` / `Directory.Packages.props`.

## 1. Detection (host, official inputs only)

### 1.1 Redundant direct references — `src/host/utilities/dependency-graph.ts`

- Source: `project.assets.json` written by the restore we already run
  (`targets[tfm][id/version].dependencies` = resolved graph,
  `project.frameworks[tfm].dependencies` = direct references).
- Reject stale assets (older than the project/props files) exactly like `ProjectFrameworkResolver`
  already does; otherwise fall back to `dotnet list package --include-transitive --format json`
  (verified working on SDK 10) for the direct/transitive split.
- For each direct reference `D` (per TFM):
  - walk the graph from every **other** direct reference; if `D` is reachable, record the chain
    (`Parent -> … -> D`) and the version required along it;
  - classify:
    - `Redundant` — direct version ≤ version the graph resolves without it (safe to remove),
    - `Pinned` — direct version > graph requirement (deliberate upgrade; keep, but say so),
    - `CentralPackageVersion` — CPM: the `PackageReference` may be removed while `PackageVersion`
      stays only if no other project needs it (checked by the existing cleanup report).
- Batch endpoint `getDependencyIssuesAsync({ ProjectPaths })` → `{ Projects: [...] }`, cached per
  restore output.

### 1.2 Conflict model — reuse, don't reinvent

- `restore-diagnostics.ts` already extracts `NU1107/NU1605/NU1608/NU1102` with constraint chains.
- Add `Origin` to each conflict: the project, the TFM and the property file it must be written to
  (`Directory.Packages.props` group via `CpmResolver`, or the `.csproj` `PackageReference`).
- New endpoint `fixRestoreConflictAsync({ ProjectPath, PackageId, Version, Target })` that applies
  exactly one change through the existing writers (`CpmResolver.UpdatePackageVersionAsync` for CPM
  group scope, `dotnet add package --version` otherwise), then restores through the job runner and
  reports the outcome. No new write path.

## 2. UI

### 2.1 Cleanup tab — "Transitive duplicates" section (moved from Installed on request)

- Header row above the package list, collapsed by default:
  *"3 direct references are already provided transitively — Review"*.
- Each row: package, direct version, `via ParentA -> B`, badge `Redundant` / `Pinned (kept)`.
- Actions: **Remove reference** (single) and **Remove all safe** (only `Redundant`), both confirmed;
  `Pinned` rows explain why they are kept and offer nothing destructive.
- CPM: removing the `PackageReference` is enough; afterwards the existing Cleanup tab reports the
  now-unused `PackageVersion` (do not auto-delete it here).

### 2.2 Conflict resolution card

Extend `<actionable-error>` usage in the Updates tab and the single-project error path with
conflict-specific actions driven by `restore-diagnostics` output:

- **Pin `<Package>` to `<suggestedVersion>`** — writes the version to the group/TPM-aware place and
  re-restores.
- **Update `<Package>` to `<version>`** — for chains that name a higher requirement.
- **Show chains** — already available as text; keep it inside the card.
- **Retry without `<Package>`** — existing batch-retry path, now also offered for single restores.
- Every action runs through `startBatchUpdate`-style jobs (`JobKind` reuse) so progress, cancel and
  rollback semantics stay unchanged.

**Implemented deviation:** the duplicate section lives in the **Cleanup** tab (it was first built in
Installed), and the Cleanup badge counts unused props entries plus removable duplicates.
 removal reuses the existing project-update job (`Type: "UNINSTALL"`) rather
than a new endpoint, so the write/restore/rollback path is unchanged; `fixRestoreConflictAsync`
auto-detects CPM vs project reference when the caller omits `Target`; "Retry without" remains the
batch-only action it already was.

## 3. Tests

- `dependency-graph.test.ts` — fixtures with a redundant direct reference, a deliberate pinned
  upgrade, a diamond dependency, a CPM project, and stale `assets.json`.
- `restore-diagnostics` — existing tests cover parsing; add `Origin` (props file + group) mapping.
- Host: `fixRestoreConflictAsync` writes CPM group scope vs project reference (existing CPM
  fixtures), and restores once through the job runner.
- Web: Installed-tab section (counts, `Pinned` rows are not removable, confirmation gates),
  conflict card actions dispatch the right request.
- Regression from AGENTS.md: a CPM package with `CpmResolutions` and empty `Version` must still be
  processed per TFM in the new views.

## 4. Verification

- `npx tsc --noEmit`, `npm run lint`, `npx vscode-test` (full suite), `npm run esbuild`.
- Manual: on `I-Synergy.Identity`, remove a redundant reference, confirm restore succeeds and the
  project still resolves the package transitively; on a synthetic NU1107 fixture, pin and re-restore.

## 5. Risks

| Risk | Mitigation |
|---|---|
| Removing a "redundant" reference changes a deliberately pinned version | `Pinned` classification is never removable; only `Redundant` is actioned |
| `project.assets.json` stale after edits | mtime guard + `dotnet list` fallback |
| CPM: delete the `PackageVersion` too early | never delete here; Cleanup tab reports it |
| Conflict fix touches the wrong group | `Origin` comes from the same per-TFM resolver used by Installed/Updates |
