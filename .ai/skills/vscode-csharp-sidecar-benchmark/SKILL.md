---
name: vscode-csharp-sidecar-benchmark
description: >-
  Benchmark a VS Code extension's TypeScript implementation against its .NET sidecar (C#) for
  time AND memory — parse latency, allocation per operation, retained heap, sidecar process RSS,
  wire round-trip — and report the trade honestly. USE FOR: "is the C# port faster or lighter
  than the TypeScript it replaced", comparing an extension host path with a sidecar process,
  validating or refuting a perf claim about a `postMessage`/NDJSON RPC migration, recovering the
  deleted TypeScript baseline from git history to measure against, explaining why a release that
  "feels snappier" still uses more memory, deciding whether a sidecar earns its footprint.
  DO NOT USE FOR: profiling inside one runtime, UI jank or render performance, writing tests for
  a port, designing the sidecar protocol itself, or planning the conversion (use
  vscode-ts-to-csharp-migration).
---

# VS Code extension + C# sidecar: benchmark the port, not the vibe

A migration from TypeScript-in-the-extension-host to C#-in-a-sidecar is **not** a speed
optimisation with a memory side effect. It moves work between two processes and two garbage
collectors. "Faster" and "lighter" are independent claims and routinely disagree: the same port
can cut host time 10× and add 25 MiB of resident memory.

This skill measures both, compares like with like, and refuses to publish a number that was not
produced by a parity-checked harness.

## When this applies

- A feature was ported from the extension host (TypeScript/Node) to a .NET sidecar, or the reverse.
- Someone says "X is faster" / "it feels snappier" / "the sidecar costs too much" — without numbers.
- You must decide whether a sidecar process is worth its footprint.
- You need to compare against code that no longer exists in the working tree.

Not for: single-runtime profiling, webview/renderer performance, or protocol design. Those need
different tooling.

## The asymmetry you must model first

```
VS Code extension host (Node)          .NET sidecar (separate process)
  parse → maps held in JS heap           parse → maps held in .NET heap
  allocations pause the host             allocations pause only the sidecar
  cost: 0 extra processes                cost: ~25–60 MiB RSS, always resident once started
```

Consequences that decide the whole report:

1. **A sidecar is not free even when idle.** Measure idle RSS *and* loaded RSS.
2. **Host-side numbers must exclude sidecar work, and total numbers must include it.**
   Report (a) the operation in each runtime, (b) the host-side share, (c) end-to-end through the
   real transport. Do not mix them into one "faster" headline.
3. **In both variants the sidecar may already exist.** Check the baseline revision: if the
   sidecar was present before the port, the delta is *where the work runs*, not "one process vs
   two". Confirm with `git log` before writing that sentence.

## Hard rules

| Rule | Why |
|---|---|
| **Parity first, always** | A memory/time number from a wrong parse is worthless. Assert identical output on every fixture *before* timing anything. |
| **Interleave the two implementations** | Run TS, then CS, then TS, then CS. Thermal drift and page-cache state then hit both equally. Never run all of A then all of B. |
| **Medians of ≥30 iterations after ≥5 warmups** | First-call JIT and cold caches are 2–10× the steady state. |
| **Report deltas, not absolutes** | RSS includes shared runtime pages. `peak − idle` and `after − baseline` are the comparable quantities. |
| **Measure the steady state *and* the burst** | RSS grows with GC heap; run enough calls (≥50, plus a 200-call burst) to show it plateaus rather than leaks. |
| **Separate allocation from retention** | Allocation per op is throughput/GC pressure. Retention is footprint. They answer different questions. |
| **Name the machine and the runtimes** | "arm64, Node 26.12.1, .NET 11.0.100-rc.3, Release" belongs in the report header. |

## Workflow

### 0. Pin both revisions

The baseline usually only exists in history.

```bash
git log --all --diff-filter=D --pretty='%h %ad %s' --date=short --name-only -- '*the-deleted-file.ts'
# the deletion commit's parent is your baseline
git rev-parse <deletion-commit>^
git cat-file -e <parent>:<path/to/file.ts> && echo exists
```

- Extract the baseline **plus its sibling modules and stubs** (a logger that imports `vscode`
  will drag the whole editor into a benchmark; stub it).
- Record both commit ids in the report.
- Check whether `dist/` or `bin/` artifacts are stale relative to the source you measure; run the
  sidecar from a fresh Release build of the tree you are measuring, not from `dist/`.

### 1. Build each variant standalone

```bash
# TypeScript baseline -> one CJS bundle
npx esbuild <entry>.ts --bundle --platform=node --format=cjs --outfile=out/baseline.cjs \
  --node-paths=<repo>/node_modules
```

The `--node-paths` (esbuild JS API: `nodePaths`) escape hatch is what lets a bundle live outside
the repo and still resolve the project's dependencies. Prefer the JS API when the CLI flag is
missing in your esbuild version.

For C#, reference the project directly from a throwaway console app — no package publish, no
solution edit:

```xml
<ProjectReference Include="<abs>/path/To/Project.csproj" />
```

Target the same TFM as the product and set `RollForward=LatestMajor` if only a newer SDK is
installed.

### 2. Workloads: synthetic for signal, real fixtures for truth

Use both, and label them:

- **Synthetic**: large enough that fixed overhead disappears (e.g. 1,000 entries, ~130 KiB).
  Generated by a script so it is reproducible and never committed.
- **Real**: the project's own fixtures, unmodified. Small files are dominated by fixed overhead —
  that is a finding, not noise. Report them separately.

Keep the *semantics* realistic: copy condition shapes, grouping and duplication patterns from the
real fixtures rather than inventing a grammar the parser has never seen.

### 3. Parity gate

Dump a canonical form from both implementations and compare byte-for-byte:

```bash
node --expose-gc ts-bench.mjs <file> dump > out/ts.json
./cs-harness <file> dump                > out/cs.json
node parity.mjs                          # compares every fixture + the synthetic workload
```

Sort keys before dumping. Compare the *derived* results too (resolution rows), not just the raw
map. When parity fails, stop: either the baseline is older than the port (a real behaviour
difference worth documenting) or your harness is wrong.

### 4. Time and allocation, interleaved

`run-rounds.mjs` alternates the two harnesses per round and reports medians.

Metrics per phase (parse, resolve/derive):

| Metric | Node | .NET |
|---|---|---|
| Wall time | `process.hrtime.bigint()` | `Stopwatch.GetTimestamp()` |
| Allocation per op | heap-growth proxy: `heapUsed` delta ÷ runs without GC | `GC.GetTotalAllocatedBytes(precise: true)` delta ÷ runs |
| Retained after GC | `heapUsed` after `global.gc()` ×2, minus baseline | `GC.GetTotalMemory(true)` minus baseline |
| Peak footprint | sampled `process.memoryUsage().rss` | `Process.PeakWorkingSet64` / sampled `WorkingSet64` |

Node has no cumulative-allocation counter. Say "heap growth per op (proxy)" in the report rather
than pretending it is exact.

### 5. Host-side share and transport

This is the number the extension actually pays.

- **TS**: the parse happens here — peak heap delta during one parse is the transient cost.
- **CS**: the host only decodes the wire payload. Feed it the **real** payload captured from the
  real sidecar (not a hand-made object), run the same wire→`Map` conversion the product uses, and
  measure peak heap and retained heap.
- **End-to-end**: `sidecar-probe.mjs` speaks the real protocol, so latency includes spawn,
  NDJSON framing, JSON decode and the host-side rebuild. Report steady-state medians (last 20 of
  50 calls), not the cold first call.

### 6. Sidecar footprint

Sample RSS by PID from outside the process:

```powershell
powershell -NoProfile -Command "(Get-Process -Id $pid).WorkingSet64"
```

Measure: idle after handshake → after 10/20/…/50 calls → after a 200-call burst (peak and
settled). A rise that plateaus is GC heap; a rise that never stops is a leak. State which.

### 7. Do not forget the derived operations

The port usually moved more than one entry point. If the old TypeScript also resolved, merged or
post-processed, measure that too — it may be where the regression hides. In the worked example
below, parse won by 5.7× and resolve barely won while allocating 50× more.

### 8. Report

Use `references/reporting-template.md`. Minimum content: revisions, machine, runtimes, workloads,
parity result, per-phase table, sidecar footprint table, and an explicit **"what this does not
cover"** section. Never end with a single "faster" verdict when the memory moved the other way.

## Interpreting results

| Observation | What it means | What to write |
|---|---|---|
| Host time ↓, sidecar RSS ↑ | Classic port trade | "Faster per operation, ~N MiB more resident memory. Latency and footprint moved in opposite directions." |
| Large-file gain ≫ small-file gain | Fixed overhead dominates small inputs | "Wins on big inputs; parity or slight loss on typical ones." (RPC round-trip floor.) |
| Allocation ↓ in host, ≈ same in total | Work moved, not removed | "The host no longer pays; the machine still does." |
| Allocation ≫ time win in the new code | Suspect per-item re-parsing/re-evaluation | Record as follow-up with a code pointer; do not "fix" it in the measurement task. |
| RSS rises then plateaus | GC heap utilisation | "Not a leak." Show the 200-call burst. |
| Latency plateaus after warmup | JIT/tiering | Report steady-state medians and say so. |

## Pitfalls (each one cost real time)

1. **Hold/drop retention deltas are unreliable in Node.** One-shot "parse and hold" vs
   "parse and drop" swings by megabytes between runs because V8 does not always reclaim promptly.
   Prefer the retained value after *many* parse cycles, and mark it noisy.
2. **`process.resourceUsage().maxRSS` is a high-water mark** and cannot be differenced. Sample
   `rss` after each iteration instead.
3. **`execFileSync` truncates large dumps.** Raise `maxBuffer` when piping JSON fixtures.
4. **Do not reuse a fixed package-id list against a small fixture.** Resolving 1,000 ids against
   a 3-package map measures the "unknown package" fallback, not the product path. Derive ids from
   the parsed map.
5. **The baseline may legitimately differ.** A feature added after the port (e.g. MSBuild property
   resolution) makes parity fail correctly. Document it; do not "fix" the harness to hide it.
6. **Sidecar start-up is ~90 ms.** Exclude it from per-call latency, but report it — the first
   CPM/nuget operation of a session pays it.
7. **Preview SDKs and `RollForward`**: buildings targeting `net8.0` can run on an 11.x runtime.
   Record the runtime that actually executed, not just the TFM.
8. **The working tree may already be dirty.** Check `git status` before and after; benchmark
   scratch files belong in `$TMPDIR`, never in the repo. Also check whether unrelated modified
   files existed before you started, so you do not attribute them to your run.
9. **Do not benchmark "both variants" if the sidecar already existed in the baseline.** Re-read
   step 0.
10. **Force GC twice**, not once, before a retention baseline; finalizers and weak handles can
    need a second pass.

## Worked example (NuGet Package Manager, 2026-11-02)

CPM parsing ported from `cpm-resolver.ts` (`389efd0`) to `CpmPropsReader` (`db15414`); synthetic
1,000 packages / 128.5 KiB, medians of 3 interleaved paired rounds.

| Metric | TypeScript host | C# core | C# end-to-end (sidecar) |
|---|---|---|---|
| Parse | 24.1 ms | 4.2 ms | 2.3 ms steady |
| Parse, 3-package fixture | 0.160 ms | 0.094 ms | 0.25 ms |
| Transient heap per parse (synthetic) | 922 KiB | 230 KiB host + 933 KiB core | — |
| Retained after 30 cycles | ~127 KiB | ~1 KiB | — |
| Resolve (1,000 pkgs × 2 TFMs) | 25.9 ms, 0.8 MiB | 18.7 ms, 44.4 MiB | — |
| Sidecar RSS | — | 28.3 MiB idle, 51.1 MiB after 50 reads, 59.8 MiB peak over 200 | — |

Verdict recorded: **memory did not drop, it moved**; large-file reads are ~10× faster with 4×
less host garbage, small files are at parity or ~0.1 ms slower, and the machine carries a
second process. Full method, parity result and follow-ups:
`references/worked-example-nuget-package-manager.md`.

## Checklist before publishing numbers

- [ ] Both revisions recorded; sidecar presence verified in the baseline
- [ ] Baseline built standalone (stubs for editor imports) and C# built Release
- [ ] Synthetic + real workloads, both reported
- [ ] 13/13 (or all) parity comparisons pass, raw and derived
- [ ] Interleaved rounds, warmups excluded, medians stated
- [ ] Host-side share measured with the real wire payload
- [ ] Sidecar idle/loaded/peak RSS + a call-count burst proving plateau
- [ ] Derived operations measured, not just parse
- [ ] Machine, OS/arch, Node and .NET runtime versions in the report
- [ ] Trade-offs stated in both directions; non-findings listed
- [ ] Scratch harness deleted or kept outside the repository

## Resources

- `references/measurement-metrics.md` — metric definitions, formulas, what is and is not comparable
- `references/sidecar-transport-and-rss.md` — NDJSON protocol probing, RSS sampling, warmup
- `references/reporting-template.md` — copy-paste report skeleton with the required sections
- `references/worked-example-nuget-package-manager.md` — a full run, including the port that got faster
  and heavier at the same time
- `scripts/gen-workload.mjs` — synthetic props generator (counts via env)
- `scripts/ts-bench.mjs` — Node harness (time, heap growth, retention, peak RSS)
- `scripts/parity.mjs` — dump-and-compare gate across fixtures
- `scripts/sidecar-probe.mjs` — real sidecar: idle/loaded RSS, round-trip latency, payload capture
- `scripts/run-rounds.mjs` — interleaved paired-round orchestrator and median table
- `scripts/cs-harness/` — C# console harness template (rename the entry points per project)
