# Wave 2 — one package row across the tabs

Status: DONE
Started: 2026-11-02
Completed: 2026-11-02

## Steps
- [x] Extend `package-row` with slots, flags and `package-selected`
  - Added `showIcon`, `showDescription`, `showMeta`, `showVersion`, `showAuthors`, `selectable` flags
  - Added `leading`/`badges`/`actions`/`details` slots and `onNameClick()` emitting `package-selected`
- [x] Migrate Consolidate's header/actions into the slots
  - `renderPackageRow` now emits `<package-row>` with badges/actions/details slots; added `toPackageRowModel`
- [x] Migrate Vulnerabilities' severity/badges/advisory into the slots
  - `renderPackageRow` now emits `<package-row>` with leading/badges/actions/details slots; added `toPackageRowModel`
- [x] Move the badge/action CSS out of the removed `.row-header` blocks
  - Consolidate: `.cpm-badge`/`.row-actions` now direct children of `.inconsistent-row`; removed `.row-header`, `.package-name`
  - Vulnerabilities: `.severity-badge`/`.advisory-link`/`.tfm-list`/`.transitive-badge` direct under `.vuln-row`; removed `.row-header`, `.package-name`
- [x] Add/update component tests and run typecheck, tests and esbuild
  - Added render assertions to consolidate-view.test.ts and new vulnerabilities-view.test.ts

## Notes
