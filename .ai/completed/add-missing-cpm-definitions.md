# Add missing central package definitions

Status: IN PROGRESS
Started: 2026-11-11
Plan: `.ai/plans/add-missing-cpm-definitions.md`

## Steps

- [x] Report model: structured `Missing` entries, CPM-only usage, version from assets, reasons
- [x] Pure writers: add unconditional entries, inspect/remove inline versions, tests
- [x] Job + RPC: add operations with snapshot/backup/rollback/restore
- [x] Cleanup view: per-row Add, header button, confirmation, status, refresh
- [x] Host tests (report + operation)
- [x] Component tests
- [x] Docs: README + CHANGELOG
- [x] Full `npm run quality` and diff review

**Status:** DONE

## Result

- `CleanupReport.Missing` is structured (`Id`, `Version`, `Projects`, `PropsFiles`, `Actionable`,
  `Reason`); only CPM-enabled projects count, and a package used only by non-CPM projects is no
  longer flagged.
- New `cpm-definitions.ts` writers add unconditional `PackageVersion` entries and strip literal
  inline `Version` attributes; conditional/property/pinned references are refused.
- New `addMissingDefinitions` job: snapshot → timestamped backup → write + verify → restore →
  rollback on failure/invalidations; per-row and bulk UI actions with confirmation and cancel.
- Tests: 572 TypeScript tests passing (13 writer, 10 host, 4 component added); `npm run quality`
  PASS 8/8.
- Docs: README Cleanup list + CHANGELOG.

## Notes

- Only actionable when exactly one concrete version is known and every using CPM project has a props
  file; everything else stays visible with a reason.
- Non-CPM projects are not flagged.
