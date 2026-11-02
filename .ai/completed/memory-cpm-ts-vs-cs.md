# Memory: C# CPM read path vs the former TypeScript resolver

Status: DONE
Date: 2026-11-02
Plan: `.ai/plans/memory-cpm-ts-vs-cs.md`

## Question

Commit `2a1a5d6` moved CPM parsing from `CpmResolver` (TypeScript, extension host) to
`CpmPropsReader` (C#, .NET sidecar). The earlier evaluation measured **time only**. This note
adds the memory side: what each variant allocates, what it retains, and what the sidecar
costs in total.

Compared: TypeScript `cpm-resolver.ts` at `389efd0` (last revision before deletion) against
`CpmPropsReader` at `db15414`.

## Environment

- Windows 11 on ARM64, Node.js 26.12.1, .NET SDK 11.0.100-rc.3 (runtime 8.0.33 for the core).
- Both implementations built Release and measured in separate, interleaved processes:
  5 warmup + 30 measured iterations, 3 paired rounds, medians reported.
- Workloads: a synthetic `Directory.Packages.props` (1,000 unconditional + 12 conditional
  groups × 100 entries; 2,232 lines, 128.5 KiB) and the real fixture
  `unconditional-plus-conditional.props` (3 packages).
- Sidecar measured as a real `dotnet NugetPackageManager.Core.dll` process over NDJSON.

## Parity first

Before any number: both implementations produce **identical** unconditional maps, conditional
groups and `ResolveVersions` rows for all 13 `Fixtures/cpm/*.props` files and the synthetic
file (13 × map + resolve comparisons, all equal). The numbers below therefore describe the same
work.

## Parse (`getCpmMap`)

| Workload | TS in host | C# in core | C# end-to-end (real sidecar, steady) |
|---|---|---|---|
| synthetic, 1,000 packages / 128.5 KiB | **24.1 ms** | 4.2 ms | **2.3 ms** |
| fixture, 3 packages | **0.160 ms** | 0.094 ms | 0.25 ms |

| Workload | TS transient heap / parse | C# host-side wire decode | C# core-side allocation |
|---|---|---|---|
| synthetic | **922 KiB** | 230 KiB | 933 KiB |
| fixture | 111 KiB | 19 KiB | 18 KiB |

- Large files: the host-side read is ~10× faster end-to-end and leaves 4× less garbage in the
  extension host, because the DOM/xpath work happens in another process.
- Small files: parity, slightly slower through the RPC (0.25 ms vs 0.16 ms). This is not a
  regression anyone can feel, but the CPM read path did not get faster for typical props files.
- Total allocation per parse is roughly the same in both designs (~1.1 MiB); the difference is
  **where** it lands, not how much the machine allocates.

## Sidecar footprint

| State | RSS |
|---|---|
| idle after handshake | **28.3 MiB** |
| after 50 reads of the synthetic file | 51.1 MiB |
| after 200 reads (peak) | 59.8 MiB |
| after 200 reads (settled, post-GC) | ~50.5 MiB |
| after 50 reads of the 3-package fixture | 45.6 MiB |

- The growth plateaus (200-call run rises then falls back), so it is GC-heap utilisation, not a
  leak.
- It is **not proportional to file size**: a 5-line props file still drives the process to
  ~45 MiB. The cost is the process plus per-request garbage, not the parsed document.
- Host retention after 30 parse cycles holding one map: ~127 KiB (TS) vs ~1 KiB (C#). Too small
  and too noisy to matter; the cached map per props file (`cpmMapCache`) is negligible either way.

## Resolution (`ResolveVersions`, per project)

Not part of `getCpmMap`; `WorkspaceModelService` calls it inside the core, while the TS baseline
resolved in the host.

| Workload | TS | C# |
|---|---|---|
| synthetic, 1,000 packages × 2 TFMs | 25.9 ms, ~0.8 MiB/call | **18.7 ms**, **44.4 MiB/call** |
| fixture, 3 packages × 2 TFMs | **0.009 ms** | 0.098 ms, 15 KiB/call |

The C# resolve allocates ~45 MiB per call on the large file — about 45 KiB per package — while
being only 1.4× faster. The allocation pattern matches `ResolutionForTfm`
(`CpmPropsReader.cs`): for every package and every TFM it re-evaluates `CpmCondition.Evaluate`
across all 12 conditional groups (24,000 evaluations per call). Not profiled further and **not
fixed** in this task; recorded as a follow-up.

## Conclusion

- **Memory did not go down; it moved.** The extension host now allocates ~4× less per CPM read
  and does no blocking parse, but the machine carries a second process at ~28 MiB idle and
  ~45–60 MiB under load. Per work performed, total allocation is unchanged.
- **The speed win is real for large props files** (~10× on the synthetic workload, ~1.7× even
  in-process for small ones) and negligible in latency for small ones.
- The reported "feels snappier" is consistent with the large-file numbers and with the host no
  longer stalling on DOM parsing, but it cannot be attributed to memory — total footprint is
  higher. Other changes in the same release (metadata via `NuGet.Protocol`, batch/job plumbing)
  are not covered here.

## Caveats

- One machine, one runtime pair; RSS includes shared runtime pages, so deltas — not absolutes —
  are the comparable quantity.
- The synthetic file is much larger than a typical `Directory.Packages.props`; the real fixture
  result is reported next to it for exactly that reason.
- Measurements ran against a Release build of the current tree. The shipped `dist/core` in the
  working copy is an earlier build of the same code path.
- The benchmark harness lived in `$TMPDIR/memcmp` and is deliberately not committed.
