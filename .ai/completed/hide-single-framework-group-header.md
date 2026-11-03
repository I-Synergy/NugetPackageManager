# Hide the "Shared" group header when only one framework is present

Status: DONE
Started: 2026-11-03

## Steps

- [x] `shouldShowFrameworkGroups` helper in `@/common/framework`
- [x] Updates, Consolidate and Installed lists render the header only for 2+ groups
- [x] tests (helper + three components)
- [x] verification — `npm run quality` PASS (8/8), webview suites green

## Notes

Plan: `.ai/plans/hide-single-framework-group-header.md`.
`cleanup-view`'s group header is a section header (Unused / Duplicates) and stays.
