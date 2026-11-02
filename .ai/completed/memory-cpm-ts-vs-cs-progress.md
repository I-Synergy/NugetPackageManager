# Memory measurement: C# CPM read path vs former TypeScript resolver
Status: DONE
Started: 2026-11-02
Completed: 2026-11-02
Plan: `.ai/plans/memory-cpm-ts-vs-cs.md`
Results: `.ai/completed/memory-cpm-ts-vs-cs.md`

## Steps
- [x] Extract TS baseline (`389efd0`) resolver into `$TMPDIR/memcmp` and build it standalone
- [x] Generate synthetic props workload + parity fixtures list
- [x] C# harness: `CpmPropsReader.Parse` / `ResolveVersions` + wire JSON dump
- [x] TS harness: M1-M4 parse metrics (interleaved, 5 warmup + 30 runs)
- [x] Parity assertion across fixtures and synthetic file
- [x] M5 host-side retention: TS maps vs real core JSON -> `CpmReader` shape
- [x] M6 sidecar RSS: idle vs 50 `getCpmMap` calls
- [x] M7 round-trip latency comparison
- [x] Write results to `.ai/completed/memory-cpm-ts-vs-cs.md`

## Notes
- Parity: all 13 `Fixtures/cpm/*.props` files plus the synthetic file produce identical maps
  and resolution rows in both implementations.
- Retained-map measurement (hold vs drop processes) was too noisy to use; the phase-level
  numbers from 30 parse cycles are reported instead, with the caveat recorded.
- Follow-up found (not fixed): `CpmPropsReader.ResolveVersions` allocates ~45 MiB per call for
  1,000 packages × 2 TFMs because `ResolutionForTfm` re-evaluates every condition per package
  per TFM.
- Harness lives in `$TMPDIR/memcmp` and is not committed.
