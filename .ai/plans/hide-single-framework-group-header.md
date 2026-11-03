# Hide the "Shared" group header when only one framework is present

Status: APPROVED (2026-11-03, user report with screenshot)
Started: 2026-11-03

## Symptom

The Updates tab shows a `SHARED 51` group header (with a select-all checkbox) above the list even
when every row is in the shared/unconditional group — i.e. the workspace uses one framework and
there is nothing to separate. Consolidate and the Installed list render the same header.

## Cause

`updates-view.renderPackageList`, `consolidate-view` and `packages-view` (Installed) map their
grouped rows and always emit a `group-header` per group. With one group the header is pure noise;
it only carries meaning when there are at least two framework groups.

## Fix

- `src/NugetPackageManager.VSCode.Common/framework.ts`: add
  `export function shouldShowFrameworkGroups(groups: readonly unknown[]): boolean { return groups.length > 1; }`
  with a comment: a single framework line has nothing to separate, so it gets no header.
- `updates-view.renderPackageList`: compute the groups once and render the `group-header` label
  (and its select-all checkbox) only when `shouldShowFrameworkGroups(groups)`. Rows render the
  same either way; the selection helpers are unchanged.
- `consolidate-view` list render: same.
- `packages-view` Installed list render: same.
- `cleanup-view`'s `group-header` is a section header (Unused / Duplicates), not framework
  grouping — leave it alone.

## Tests

- `@/common/framework` unit test: one group → false, two → true, empty → false.
- `updates-view.test.ts`: one shared group renders no `.group-header`; two groups (shared + net10.0)
  render one header per group.
- `consolidate-view.test.ts` and `packages-view.test.ts`: one assertion each for the single-group
  case (no header). Keep the existing grouping assertions (`groupedVisiblePackages`) untouched.

## Verification

`npm run quality`, then a test VSIX. On a single-framework repo the Updates tab must show the list
without the `SHARED` header; a multi-framework repo keeps the per-framework headers.
