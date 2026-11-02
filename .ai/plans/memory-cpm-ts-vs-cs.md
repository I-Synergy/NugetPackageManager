# Memory measurement: C# CPM read path vs the former TypeScript resolver

Status: PROPOSED — awaiting approval
Date: 2026-11-02

## Question

The CPM read path moved from `CpmResolver` (TypeScript, in the extension host) to
`CpmPropsReader` (C#, in the .NET sidecar) in commit `2a1a5d6`. That change was measured for
**time only**. The user reports the shipped build feels snappier. We have **no memory
measurement** for either variant, and the architectural cost of the move is exactly a memory
trade (sidecar process RSS + JSON wire traffic vs in-host parsing), so it must be measured
before any claim is made.

## What is being compared

| Variant | Implementation | Where the work runs |
|---|---|---|
| **TS (baseline)** | `cpm-resolver.ts` @ `2a1a5d6^` (`389efd0`) + `cpm-condition.ts`, `nuget-identifier.ts` | extension host (Node) |
| **C# (current)** | `CpmPropsReader.Parse` / `ResolveVersions` | `dotnet` sidecar |

Both revisions already contain the sidecar (`getCpmMap` handler landed in `389efd0`), so the
sidecar's fixed cost exists in both variants. The comparison is therefore about the **delta**:
host-side parse cost and retention (TS) vs host-side wire decode and retention plus sidecar
transient/steady cost (C#).

## Method

All scratch work lives in `$TMPDIR/memcmp/`. No repository source, dependency or fixture is
modified; the large workload file is generated there.

### Workload

1. **Synthetic `Directory.Packages.props`** — 1,000 `PackageVersion` entries, 12 conditional
   `ItemGroup`s (~100 entries each) using the condition shapes already present in
   `tests/NugetPackageManager.TestUtilities/Fixtures/cpm` (`net8.0`, `net9.0`, `net10.0`,
   `net11.0`, `windows`, negated and `StartsWith` forms). ~2k lines, ~90 KB.
2. **Real fixtures** — the 13 `.props` files under
   `tests/NugetPackageManager.TestUtilities/Fixtures/cpm` plus the repository-root fixture,
   parsed once each (correctness/parity check, not the headline number).

### Runs

- 5 warmup + 30 measured iterations per variant, **interleaved** (TS, CS, TS, CS…) so drift
  (thermal, GC, page cache) hits both sides equally. Report medians.
- Node 26.12.1 arm64 with `--expose-gc`; .NET SDK 11.0.100-rc.3 arm64, Release.

### Metrics

| # | Metric | How |
|---|---|---|
| M1 | **Time per parse** (median, µs) | `hrtime.bigint()` in Node; `Stopwatch` in C# |
| M2 | **Allocated bytes per parse** | Node `v8.getHeapStatistics().total_heap_size` delta + `process.memoryUsage()`; C# `GC.GetTotalAllocatedBytes(precise: true)` |
| M3 | **Retained memory after parse**, post-GC | Node `heapUsed`/`external` after forced GC minus idle baseline; C# `GC.GetTotalMemory(true)` minus baseline |
| M4 | **Peak RSS during parse** | Node sampled `process.memoryUsage().rss`; C# `Process.PeakWorkingSet64` |
| M5 | **Host-side retention for the real path** | TS: resolver output mapped like `host-api.ts` holds it. C#: real core JSON for the same file → `JSON.parse` → `CpmReader` wire→`Map` shape → hold. Post-GC delta per variant. |
| M6 | **Sidecar cost** | Spawn the real `dist/core` sidecar, sample RSS at idle after handshake, then after 50 `getCpmMap` calls on the synthetic file (peak + steady). `dist/core` is rebuilt only if stale; otherwise the existing build is used. |
| M7 | **Round-trip latency** (context for "snappier") | TS in-process parse vs `getCpmMap` over stdio, same 30 interleaved iterations |

### Correctness guard

Before timing, assert both variants produce the same `unconditional` map and the same
conditional `(framework, package → version)` set for every fixture and the synthetic file.
A memory number from a wrong parse is worthless.

## Deliverables

1. `.ai/progress/memory-cpm-ts-vs-cs.md` (tracked, moved to `.ai/completed/` at the end).
2. `.ai/completed/memory-cpm-ts-vs-cs.md` with: environment, method, M1–M7 tables, the
   parity result, and an explicit statement of what the numbers do **not** cover
   (e.g. VS Code's own renderer memory, NuGet HTTP work, realistic project counts).

## Non-goals

- No shipped code change, no new dependency, no fixture edit.
- No performance tuning in this task — measurement only.
- No claim about the user's subjective "snappier"; the numbers speak for themselves.

## Risk / caveats to state in the report

- Process RSS on Windows includes shared runtime pages; deltas, not absolutes, are the
  comparable quantity.
- The sidecar is a second process: the extension's total footprint grows by its RSS even
  though per-parse work disappears from the host. Both facts get reported.
- The synthetic file is larger than typical real `Directory.Packages.props`; the real
  fixtures are reported separately so the small-file behaviour (fixed overhead dominating)
  is visible.
