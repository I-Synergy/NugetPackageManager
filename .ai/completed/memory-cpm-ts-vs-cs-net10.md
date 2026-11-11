# CPM parse/resolve: TypeScript host vs .NET sidecar on .NET 10

Status: DONE
Date: 2026-11-11
Plan: n/a — re-run of the 2026-11-02 benchmark (`memory-cpm-ts-vs-cs.md`) after the sidecar moved
from `net8.0` to `net10.0`.

## Question

Commit `2a1a5d6` moved CPM parsing from `CpmResolver` (TypeScript, extension host) to
`CpmPropsReader` (C#, sidecar). The original benchmark ran the sidecar on the .NET 8 runtime. The
sidecar now targets `net10.0` (and `RollForward=LatestMajor`), so: did the .NET 10 runtime change
the trade-off? Compared: TS `cpm-resolver.ts` at `389efd0` against the current working tree
(`02c8c03` plus the uncommitted net10 work), Release builds.

**Runtime nuance, measured not assumed.** With `RollForward=LatestMajor`, the `net10.0` app chooses
the newest installed major. On this machine that is **11.0.0**, not 10.x. Both configurations are
reported below:

- **10.0.15** — the runtime pinned with `DOTNET_ROLL_FORWARD=Minor` (the true .NET 10 numbers).
- **11.0.0** — what the shipped configuration actually runs here today.

## Environment

- Windows 11 arm64; Node.js 26.12.1; .NET SDK 11.0.100
- Runtime actually used: `Microsoft.NETCore.App` **10.0.15** (pinned) and **11.0.0** (default
  `LatestMajor`); confirmed with `COREHOST_TRACE`
- Build: Release for both; TS bundle built with esbuild from `389efd0`, C# harness and sidecar
  published from the working tree
- Baseline revision: `389efd0`; current: `02c8c03` + uncommitted `net10.0` changes
- Harness: `.reasonix/skills/vscode-csharp-sidecar-benchmark/scripts`, adapted in session scratch;
  nothing committed

## Workloads

- Synthetic: 1,000 unconditional + 12 conditional groups × 100 entries; 2,232 lines, 128.5 KiB
  (`gen-workload.mjs` defaults).
- Real: `Fixtures/cpm/unconditional-plus-conditional.props` (2 packages, 1 condition).

## Parity

All 12 `Fixtures/cpm/*.props` files plus the synthetic workload produced identical unconditional
maps, conditional groups and `ResolveVersions` rows on both runtimes: **13/13 inputs identical**
(raw map and derived rows). The `.NET 10` numbers therefore describe the same work as the TS
baseline.

## Time

Medians of 3 interleaved paired rounds, 5 warmups + 30 measured iterations per round. The table
uses the second pinned run; the first pinned run agreed within noise (TS 26.2 ms, C# 4.2 ms,
resolve 28.1/17.9 ms).

| Workload | TS in host | C# in core (.NET 10.0.15) | C# sidecar, steady (real NDJSON) |
|---|---|---|---|
| parse, synthetic | 25.0 ms | **4.1 ms** | **2.4 ms** |
| parse, 2-package fixture | 0.156 ms | 0.043 ms | 0.22 ms |
| resolve, synthetic (1,000 pkgs × 2 TFMs) | 26.6 ms | 19.0 ms | — |
| resolve, fixture | 0.017 ms | 0.041 ms | — |

For reference, the same run with the default runtime (11.0.0): parse 25.1 / 4.5 / 2.4 ms; fixture
0.149 / 0.034 / 0.24 ms; resolve 27.3 / 17.0 ms. The differences between 10.0.15 and 11.0.0 are
run-to-run noise.

Sidecar cold start (ready handshake): **124.8 ms** pinned to 10.0.15, **79.7 ms** on 11.0.0
(single samples; the earlier record saw ~90 ms). It is paid once per session and excluded from the
per-call medians.

## Memory

| Metric | TS host | C# host decode | C# core |
|---|---|---|---|
| Heap growth / parse, synthetic | 266–316 KiB (proxy) | 108 KiB (JSON.parse + map build) | — |
| Exact allocation / parse, synthetic | — | — | 933 KiB |
| Heap growth / parse, fixture | 112 KiB | 1.9 KiB | 18 KiB |
| Retained after 30 parses (hold one map) | 123 KiB | — | 1 KiB |
| Peak RSS of the harness process | 116.2 MiB | — | 47.3 MiB |

- Node has no cumulative allocator; its number is heap growth, not exact allocation. It varied
  266–316 KiB across two pinned runs (the earlier .NET 8 run recorded 922 KiB), so treat it as a
  noisy proxy. The exact C# figure is 933 KiB/parse — the same order of magnitude. **Total work is
  similar; the port moved it out of the host, it did not remove it.**
- The host-side decode number (108 KiB incl. `JSON.parse`, 0.95 ms) measures the same wire shape
  the .NET 8 record reported at 230 KiB; the payload here is 46,053 bytes and the harness scope may
  differ, so do not read that as a runtime improvement.
- The C# resolve still allocates **45.5 MiB per synthetic call** (~45 KiB/package) — the known
  `ResolutionForTfm`/`CpmCondition.Evaluate` follow-up from the .NET 8 run, unchanged on .NET 10.

## Sidecar footprint

Real `dotnet NugetPackageManager.Core.dll` over NDJSON, `.NET 10.0.15`:

| State | RSS |
|---|---|
| idle after handshake | 28.3 MiB |
| after 50 reads of the synthetic file | 50.6 MiB |
| after 200 calls (peak) | 60.3 MiB |
| after 200 calls (settled) | 50.3 MiB |
| after 50 reads of the 2-package fixture | 45.2 MiB |

RSS rises then settles (samples: 44 → 60 → 50 MiB over 200 calls), so this is GC-heap
utilisation, not a leak, and it is **independent of input size**: a 2-package fixture still costs
~45 MiB. The default 11.0.0 run produced 28.6 / 51.9 / 56.0 / 45.6 / 45.5 MiB — the same shape.

## Comparison with the .NET 8 run

| Metric | .NET 8 (2026-11-02) | .NET 10.0.15 (this run) | .NET 11.0.0 (default) |
|---|---|---|---|
| parse synthetic: TS / C# core / sidecar | 24.1 / 4.2 / 2.3 ms | 25.0 / 4.1 / 2.4 ms | 25.1 / 4.5 / 2.4 ms |
| parse fixture: TS / C# core / sidecar | 0.160 / 0.094 / 0.25 ms | 0.156 / 0.043 / 0.22 ms | 0.149 / 0.034 / 0.24 ms |
| resolve synthetic: TS / C# | 25.9 / 18.7 ms | 26.6 / 19.0 ms | 27.3 / 17.0 ms |
| C# resolve allocation | 44.4 MiB/call | 45.5 MiB/call | 45.3 MiB/call |
| sidecar idle / 50 calls / peak | 28.3 / 51.1 / 59.8 MiB | 28.3 / 50.6 / 60.3 MiB | 28.6 / 51.9 / 56.0 MiB |
| cold sidecar start | ~90 ms | 124.8 ms | 79.7 ms |

Nothing material moved. The large-file parse win (~6× in-process, ~10× end-to-end including the
TS host's extra work), the small-file parity/slight loss through the transport, and the 28–60 MiB
process footprint are the same on .NET 8, 10 and 11. The small-fixture in-process C# parse is
faster on the newer runtimes (0.034–0.043 ms vs 0.094 ms); it is sub-0.1 ms either way and does
not change a verdict.

## Verdict

- **Latency:** unchanged by the TFM move. Large props files are ~6× faster in-process and
  ~10× faster end-to-end than the TS host; typical 2–3-package files are at parity (0.22–0.24 ms
  through the sidecar vs 0.15–0.16 ms in the host) — not perceivable, but not a win.
- **Memory:** unchanged by the TFM move. The extension host still does less work, but total
  allocation is the same order of magnitude and the machine carries a second process at ~28 MiB
  idle and ~45–60 MiB under load. The 45.5 MiB/call resolve allocation is still there.
- **Net:** "faster but heavier", exactly as recorded for .NET 8. Moving the target to .NET 10
  neither improves nor worsens the trade; with `RollForward=LatestMajor` on a machine that has
  .NET 11, the shipped sidecar runs on 11.0.0 and the numbers are the same.

## Follow-ups (not done here)

1. The C# resolve allocates ~45 KiB/package per call (`ResolutionForTfm` re-evaluates every
   conditional group for every package × TFM). Unchanged since the first benchmark.
2. Consider whether `RollForward=LatestMajor` is intended: it silently runs the `net10.0` sidecar
   on .NET 11 when installed. If the runtime should be predictable, pin `Major`/`Minor`.

## What this does not cover

- Other components changed in the same release (updates scan, cleanup, sidecar protocol).
- VS Code renderer/webview memory; extension-host steadiness over a long session.
- Typical repository sizes, network-bound operations, or first-run UX.
- Portability: one Windows-arm64 machine. RSS includes shared runtime pages; deltas, not
  absolutes, are comparable.

## Reproducing

Harness lives in `$TMPDIR/nuget-bench-net10` (session scratch, disposable):
`node build-ts.mjs`, `dotnet build -c Release cs-harness`, `node parity.mjs`,
`node run-rounds.mjs`, `node sidecar-probe.mjs`, `node host-decode.mjs`.
Pin the runtime with `DOTNET_ROLL_FORWARD=Minor` for .NET 10 numbers; omit it for the
`LatestMajor` behavior. Nothing was added to the repository.
