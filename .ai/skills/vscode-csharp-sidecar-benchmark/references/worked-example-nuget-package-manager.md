# Worked example: CPM parsing, TypeScript host vs .NET sidecar

A complete run of this skill on a real port, kept because the result contradicts the assumption
that a C# port is "faster and lighter". Project: NuGet Package Manager (VS Code extension).

## The change

| | TypeScript baseline | Current |
|---|---|---|
| Code | `CpmResolver` in the extension host | `CpmPropsReader` in the .NET sidecar |
| Revision | `389efd0` (parent of the deletion commit) | `db15414` |
| Deletion commit | `2a1a5d6` — "move NuGet config resolution into the C# core" (also removed `cpm-resolver.ts`) | — |
| Sidecar in baseline? | **Yes** — the `getCpmMap` handler already existed in `389efd0`. The comparison is *where the work runs*, not one process vs two. | — |

Recovering the baseline:

```bash
git log --all --diff-filter=D --pretty='%h %ad %s' --date=short --name-only -- '*cpm-resolver.ts'
git rev-parse 2a1a5d6^          # 389efd0
git show 389efd0:src/.../utilities/cpm-resolver.ts
```

Three sibling modules were needed (`cpm-condition.ts`, `nuget-identifier.ts`, and a `Logger`
stub — the real logger imports `vscode` and OpenTelemetry). The bundle was built with esbuild
`--node-paths` against the repo's `node_modules`, outside the repository.

## Environment

Windows 11 arm64; Node.js 26.12.1; .NET SDK 11.0.100-rc.3 (runtime 8.0.33 running the core);
Release builds; both harnesses run from session scratch (`$TMPDIR/memcmp`), nothing committed.

## Parity

All 13 `Fixtures/cpm/*.props` files plus the synthetic workload produced identical unconditional
maps, conditional groups and `ResolveVersions` rows. That surprised the operator: the baseline
predates MSBuild property resolution, but both implementations return the raw `$(Property)`
token at this layer, so parity held.

## Workloads

- Synthetic: 1,000 unconditional + 12 conditional groups × 100 entries; 2,232 lines, 128.5 KiB.
- Real: `unconditional-plus-conditional.props` (3 packages).

## Results

Parse (`getCpmMap`), median of 3 interleaved paired rounds:

| Workload | TS in host | C# in core | C# end-to-end (sidecar) |
|---|---|---|---|
| synthetic | 24.1 ms | 4.2 ms | 2.3 ms steady |
| real fixture | 0.160 ms | 0.094 ms | 0.25 ms steady |

Memory:

| Metric | TS host | C# host | C# core |
|---|---|---|---|
| Transient heap per parse (synthetic) | 922 KiB | 230 KiB | 933 KiB |
| Transient per parse (fixture) | 111 KiB | 19 KiB | 18 KiB |
| Retained after 30 cycles | ~127 KiB | ~1 KiB | — |

Sidecar footprint (RSS):

| State | Value |
|---|---|
| idle after handshake | 28.3 MiB |
| after 50 reads of the synthetic file | 51.1 MiB |
| after 200 reads (peak) | 59.8 MiB |
| after 200 reads (settled) | ~50.5 MiB |
| after 50 reads of the 3-package fixture | 45.6 MiB |

Growth plateaus (the 200-call run rises then falls back) and is independent of input size — the
cost is the process plus per-request garbage, not the parsed document. Cold sidecar start: ~90 ms.

Derived operation (`ResolveVersions`, 1,000 packages × 2 TFMs):

| | TS | C# |
|---|---|---|
| synthetic | 25.9 ms, ~0.8 MiB/call | 18.7 ms, **44.4 MiB/call** |
| fixture | 0.009 ms | 0.098 ms, 15 KiB/call |

The C# resolve allocates ~45 KiB per package. The allocation pattern points at
`ResolutionForTfm`: for every package and every TFM it re-evaluates `CpmCondition.Evaluate`
across all conditional groups (24,000 evaluations per call). Not profiled further; recorded as a
follow-up rather than fixed inside a measurement task.

## Verdict recorded

- **Latency:** ~10× faster end-to-end on large props files (2.3 ms vs 24.1 ms); parity on small
  ones (0.25 ms vs 0.16 ms — the C# path is marginally slower through the transport).
- **Memory:** the host pays ~4× less garbage per parse, but the machine gains a second process at
  ~28 MiB idle and ~45–60 MiB under load. Total allocation per parse is about the same (~1.1 MiB)
  — it moved, it did not disappear.
- **Net:** "faster but heavier". The user's "feels snappier" report is consistent with the
  large-file numbers and the removed host stalls, and is explicitly *not* a memory win.

## Lessons this run produced

1. Check whether the sidecar existed in the baseline before claiming "one process vs two".
2. Parity can hold for surprising reasons (raw property tokens) — assert, do not assume.
3. A 5-line fixture still pushes the sidecar to 45 MiB; footprint does not scale with input.
4. Measure the derived operation: parse won by 5.7×, resolve barely won while allocating 50× more.
5. V8 one-shot hold/drop retention swings by megabytes; use phase-level numbers after many cycles.
