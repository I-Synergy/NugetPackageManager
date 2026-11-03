# Post-update flash: a pre-update scan is repainted after the update

Status: DONE
Started: 2026-11-03

## Steps

- [x] `scan-cache.ts`: epoch on the persisted entry + `InvalidateScanCache`
- [x] `outdated-scan-coordinator.ts`: `Invalidate()` + epoch-guarded memo
- [x] `host-api.ts`: invalidate scan state after every mutation; stamp saves with the start epoch
- [x] `updates-view.ts`: discard a scan that straddled a mutation
- [x] tests (scan-cache, coordinator, host-api, updates-view)
- [x] verification — `npm run quality` PASS (8/8), TS suite 464 passing

## Notes

Plan: `.ai/plans/post-update-stale-scan.md`.
The flash was the non-forced auto-run of the `@lit/task` between the project reload and the forced
scan: it hit the coordinator memo / persisted scan cache from before the update.
