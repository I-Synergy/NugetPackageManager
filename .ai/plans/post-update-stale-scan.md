# Post-update flash: a pre-update scan is repainted after the update

Status: APPROVED (2026-11-03, reported against the aspire test run)
Started: 2026-11-03

## Symptom

After a batch update succeeds, the Updates list clears, then the **whole pre-update list**
appears for a moment, then clears again to "no updates".

## Cause

Nothing invalidates the *scan result* when a package version changes:

1. `handleSelectedSuccessAsync` / `handleSingleSuccessAsync` remove the updated rows and
   dispatch `packages-updated`.
2. `packages-view.onPackagesUpdatedAsync` reloads projects (`LoadProjectsAsync(true)`) and then
   forces a fresh scan (`reloadChildViewsAsync(true)`).
3. Between those two, the project list changes, so `updates-view`'s `@lit/task` **auto-runs**
   with `_forceReloadNext = false`. A non-forced scan asks the host, which answers from the
   5-minute coordinator memo or the persisted `ScanCacheStore` — both still hold the scan taken
   *before* the update. `applyScan` paints the full stale list.
4. The forced scan that follows clears it.

So the flash is the pre-update scan, not a UI bug in the list rendering.

## Fix

### Host — a mutation invalidates every scan result

- `scan-cache.ts`: the persisted entry gains an `Epoch` (`SCHEMA_VERSION` bumped). Module-level
  `InvalidateScanCache()` increments it; `LoadAsync` refuses an entry from another epoch;
  `SaveAsync(entry, epoch)` writes the epoch the scan started with, so a scan that began before
  the mutation cannot overwrite the cleared cache.
- `outdated-scan-coordinator.ts`: `Invalidate()` bumps the coordinator epoch and clears the memo;
  `executeAsync` only memoizes when the epoch it captured at start is still current.
- `host-api.ts`: every place that calls `workspaceSnapshot.invalidate()` now also calls
  `outdatedScans.Invalidate()` and `InvalidateScanCache()` (one module-level
  `invalidateAfterMutationAsync()` helper). `runOutdatedScanAsync` captures
  `CurrentScanCacheEpoch()` before parsing and passes it to `saveOutdatedScanAsync`.

Effect: the non-forced scan in step 3 finds no memo and no persisted scan, so it runs against
the post-update workspace (or returns empty while the forced scan is in flight) — no stale list.

### Webview — a scan that straddled the mutation is discarded

- `updates-view.ts`: `_mutationEpoch` is bumped in both success handlers. The `_loadTask` body
  captures it before the request and, when it changed by completion, returns `{ Packages: [] }`
  instead of the pre-mutation response. The forced reload that follows repopulates.

## Tests

- `scan-cache.test.ts`: an entry from another epoch is not served; `InvalidateScanCache` makes
  the previous save unreadable; a save stamped with the old epoch stays invisible.
- `outdated-scan-coordinator.test.ts`: `Invalidate()` drops the memo; a run in flight across an
  invalidation does not repopulate it.
- `host-api.test.ts`: a `PreferCache` scan after a successful update returns no packages rather
  than the pre-update scan.
- `updates-view.test.ts`: a scan that completes after `_mutationEpoch` changed is not applied.

## Verification

`npm run quality`; a new test VSIX; manual: update all on aspire, the list must go empty and
stay empty (no repaint of the old rows).
