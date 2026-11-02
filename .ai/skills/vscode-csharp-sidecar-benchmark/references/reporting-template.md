# Report template: TS host vs C# sidecar

Copy this file into the project's completed/analysis notes and fill every section. Delete the
guidance lines; keep the headings.

---

# {Operation} port: TypeScript host vs .NET sidecar — time and memory

Status: DONE
Date: {date}
Plan: {link}

## Question

{One or two sentences: which commit moved which operation where, and what claim is being checked
or replaced. Say explicitly whether the sidecar already existed in the baseline.}

## Environment

- OS / arch: {e.g. Windows 11 arm64}
- Node.js {version}; .NET SDK {version}, runtime {version actually used}
- Build: Release for both; {built from working tree | from dist/artifact}
- Baseline revision: `{short-sha}` ({subject}); current: `{short-sha}`

## Workloads

- Synthetic: {N entries, size, generator parameters}
- Real fixtures: {paths}, {sizes}

## Parity

{All N fixtures + synthetic compared on raw map and derived results: identical / differences
listed below.}
{If differences: name them, say whether they are a real feature gap in the baseline, and exclude
or annotate those fixtures.}

## Time

| Workload | TS in host | C# in core | C# end-to-end (real transport) |
|---|---|---|---|
| synthetic | {ms} | {ms} | {ms steady} |
| real fixture | {ms} | {ms} | {ms steady} |

Warmups: {n}; iterations: {n}; rounds: {n}; reported value: median. Cold sidecar start: {ms}.

## Memory

| Metric | TS host | C# host | C# core |
|---|---|---|---|
| Transient heap / allocation per op (synthetic) | {KiB} | {KiB} | {KiB} |
| Transient per op (real fixture) | {KiB} | {KiB} | {KiB} |
| Retained after {n} cycles | {KiB} | {KiB} | — |

Sidecar footprint:

| State | RSS |
|---|---|
| idle after handshake | {MiB} |
| after 50 calls | {MiB} |
| after 200 calls (peak) | {MiB} |
| after 200 calls (settled) | {MiB} |

{Plateau or leak? Independent of input size?}

## Derived operations

{Resolve/merge/post-process results, if the port moved them. Include allocation even when time
improved, and flag per-item re-parsing as a follow-up if present.}

## Verdict

- **Latency:** {what improved, on which inputs, by how much}
- **Memory:** {what grew, what shrank, and in which process}
- **Net:** {"faster but heavier" | "lighter but slower" | "no measurable difference"} — stated in
  one sentence, with the numbers that justify it.

## Follow-ups (not done here)

1. {e.g. per-item re-evaluation causing N MiB/call}
2. {stale `dist/` build, if applicable}

## What this does not cover

- {Other components changed in the same release; no attribution to them}
- {VS Code renderer / webview memory}
- {Realistic project counts, network-bound operations, first-run UX}
- {Single machine: numbers are relative, not portable absolutes}

## Reproducing

{Commands, env vars, where the harness lives (session scratch / `$TMPDIR`), and the fact that it
is not committed. Suffix: "Scratch harness is disposable; delete it after recording these numbers."}
