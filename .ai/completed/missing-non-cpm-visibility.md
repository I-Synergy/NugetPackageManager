# Show used-but-undefined packages that only non-CPM projects use

Status: IN PROGRESS
Started: 2026-11-11
Plan: `.ai/plans/missing-non-cpm-visibility.md`

## Steps

- [x] Host: include non-CPM usage in `Missing` as `nonCpmOnly` (not actionable)
- [x] UI: new reason text, file count only when present, project paths in the tooltip
- [x] Tests: host + component updates
- [x] Docs: README + CHANGELOG wording
- [x] Full `npm run quality` and diff review

**Status:** DONE

## Result

- `Missing` includes every used id with no central definition. An entry used only by non-CPM
  projects is `Actionable: false`, `Reason: "nonCpmOnly"`, `PropsFiles: []`, and keeps the full
  project list; the row reads "Used without CPM — no definition needed" and has no Add button.
- Entries with at least one CPM use keep the existing actionability/version logic; `Projects`
  now lists every project using the package.
- Tests: 574 passing (updated non-CPM expectations, mixed CPM+non-CPM case, component reason
  text/file-count); `npm run quality` PASS 8/8.

## Notes

- The Add action stays limited to entries a CPM project needs.
- `Projects` becomes the full usage list; actionability is still computed from CPM projects.
