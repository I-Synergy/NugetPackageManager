# Show used-but-undefined packages that only non-CPM projects use

Status: IN PROGRESS
Started: 2026-11-11
Progress: `.ai/progress/missing-non-cpm-visibility.md`

## Problem

The Cleanup tab reports "8 defined entries / 10 used packages" but the **Used but not defined**
section is empty, so the two extra packages cannot be identified. The previous change filtered
`Missing` down to packages used by at least one CPM-enabled project; packages used only by
non-CPM projects were dropped from the report instead of being shown as informational.

The user needs to see which packages are used but not centrally managed, without the Add action
being offered for entries where no central definition is required.

## Decision

- `Missing` again contains **every** used package that no props file defines.
- An entry used **only** by non-CPM projects is `Actionable: false` with
  `Reason: "nonCpmOnly"`; the row stays visible with the reason and the project list in its
  tooltip. It is not added automatically.
- An entry used by at least one CPM project keeps the current behaviour (one known version,
  governing props files, Add).
- `Projects` lists every project that uses the package (CPM and non-CPM); the actionability and
  version checks still use only the CPM projects.

## Changes

- `rpc/types.ts`: add `"nonCpmOnly"` to `MissingDefinitionReason`.
- `host-api.ts`:
  - `CleanupCpmUse` records all using projects (with a CPM flag) instead of only CPM ones.
  - `collectMissingAsync` includes ids used by any project; when there is no CPM use it emits
    `nonCpmOnly`, `Actionable: false`, `PropsFiles: []`, and the single known version when the
    inline references agree.
  - Existing `noVersion` / `multipleVersions` / `noPropsFile` / reference-safety logic applies to
    the CPM subset only.
- `cleanup-view.ts`: render `nonCpmOnly` as "Used without CPM — no definition needed"; only show
  the props-file count when there is at least one file; include the project paths in the row
  tooltip for every reason. The Add button is not shown for non-actionable rows (already true).
- Tests: update the existing "non-CPM project must not flag it" test to expect one informational
  row (`nonCpmOnly`) instead of no row; add a mixed CPM + non-CPM case (still actionable) and a
  component assertion for the reason text.
- Docs: correct the README/CHANGELOG wording that says non-CPM usage is "not reported".

## Verification

`npm run typecheck`, `npm run lint`, `npm test`, then `npm run quality`.

## Out of scope

- Offering Add for non-CPM-only entries (no central definition is needed).
- Version lookup from the feed.
