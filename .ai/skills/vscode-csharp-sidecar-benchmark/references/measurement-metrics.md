# Measurement metrics: what to capture and what it means

Four numbers get confused in port discussions. Keep them separate.

| # | Metric | Question it answers | Unit |
|---|---|---|---|
| M1 | Wall time per operation | How long does the caller wait? | ms, median |
| M2 | Allocation per operation | How hard does the collector work? | bytes/op |
| M3 | Retained after collection | What stays in memory afterwards? | bytes |
| M4 | Process footprint | What does the OS see? | MiB RSS |

## M1 — wall time

- Measure **inside** the process (`hrtime.bigint()` in Node, `Stopwatch.GetTimestamp()` in .NET),
  not around process spawns.
- 5 warmups minimum, 30 measured iterations, 3 paired rounds, median of all measured iterations.
- For the sidecar, add a second M1: **end-to-end through the real transport**, steady state
  (median of the last 20 of 50 calls). That number includes framing, JSON decode and IPC wakeups.
- Report the cold start separately (~90 ms for a .NET sidecar on Windows/arm64). It is paid once
  per session and must not pollute per-call medians.

```js
const t0 = process.hrtime.bigint();
const result = parse(input);
const t1 = process.hrtime.bigint();
timesMs.push(Number(t1 - t0) / 1e6);
```

## M2 — allocation per operation

.NET gives an exact cumulative counter; Node only gives heap growth.

```csharp
var start = GC.GetTotalAllocatedBytes(precise: true);
// ... N iterations ...
var perOp = (GC.GetTotalAllocatedBytes(precise: true) - start) / N;
```

```js
const before = process.memoryUsage().heapUsed;   // no GC during the loop
// ... N iterations ...
const perOp = (process.memoryUsage().heapUsed - before) / N;   // proxy
```

Label the Node number **"heap growth per op (proxy)"**. It mixes live data, dead objects not yet
collected, and collector timing. It is still useful for relative comparisons *between two Node
runs* and for spotting order-of-magnitude differences.

Watch for allocation that dwarfs the time win. A path that allocates 45 MiB to save 7 ms is a
regression in a long-lived process even though the median latency improved.

## M3 — retained memory

- Force collection **twice** (finalizers and weak handles can need a second pass), then take
  `heapUsed` / `GC.GetTotalMemory(true)`.
- Do it after many iterations holding **one** result, not after a single iteration: single-shot
  "hold vs drop" runs in V8 swing by megabytes.
- Treat small retained values (< a few hundred KiB) as noise unless the difference is large and
  repeatable.
- Keep a global reference to the held result (`globalThis.__keep = result`) — otherwise the
  optimizer or an early collection removes it and you measure nothing.

## M4 — process footprint

- **Node**: sample `process.memoryUsage().rss` after each iteration, take the max; compare to the
  baseline taken after warmup + GC.
- **.NET in-process**: `Process.GetCurrentProcess().WorkingSet64`, `Refresh()` before reading.
- **Sidecar from outside**: query the PID (see `sidecar-transport-and-rss.md`).
- Report `idle`, `loaded`, `peak`, and `settled`. Deltas are comparable; absolutes are not,
  because shared runtime pages vary with what else is running.

## Comparability matrix

| Compared | Comparable? | Note |
|---|---|---|
| Node time vs .NET time, same input | Yes | Same operation, different runtime |
| Node heap-growth proxy vs .NET exact allocation | Directionally | Different definitions; never present as equal units |
| Node retained vs .NET retained (same logical map) | Yes, small numbers are noise | Both are post-GC reachable bytes |
| Node RSS vs .NET RSS | Yes with care | Both include runtimes' fixed cost; use deltas |
| Host-side share vs end-to-end sidecar | No | Different scopes; report both, never merge |
| Allocation in host (C# path) vs allocation in host (TS path) | Yes | This is the real "what the editor pays" comparison |

## Statistics that survive review

- Interleave implementations at **process** granularity: TS process, CS process, TS, CS… A single
  long block per variant drifts with thermal state and file-cache warmth.
- Report per-round medians as well as the overall median; if they disagree, say so.
- Show the raw array in the appendix or a sidecar JSON, not just the summary.
- Never round away a tie: "0.160 ms vs 0.25 ms" is a real regression in relative terms even
  though no user can perceive it. Say which it is.

## Environment header (required)

```
OS + arch, CPU if known
Node <version> (<arch>)
.NET SDK <version>; runtime actually used (<version>)
Build configuration: Release / Debug
Both commit ids; built from working tree or package?
```
