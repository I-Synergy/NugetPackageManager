# Porting waves: what to move, in what order, and how to know it worked

## 1. Inventory

```bash
node .ai/skills/vscode-ts-to-csharp-migration/scripts/inventory.mjs src/
```

For every `.ts` file it prints: path, line count, whether it imports `vscode` or a Node-only
module the sidecar cannot use, and a grouping summary. Use it to answer three questions:

1. How many lines sit in modules that never import `vscode`? That is the movable surface.
2. Which of those are leaves (no dependents) versus hubs (many dependents)? Leaves go first.
3. Which modules are *primitives* used inside host-side loops? They stay until their last
   consumer moves.

Reference numbers: 30 host modules, 8 importing `vscode`, **≈ 5,775 movable lines** across five
waves (remote API 727, project model 1,878, dependency semantics 462, diagnostics 455, toolchain
581).

## 2. Wave selection

A wave is a coherent domain, not a file list. Good waves share fixtures, share a third-party
library, and have a single user-level entry point.

| Wave | Move | Keep | Why the keep |
|---|---|---|---|
| Remote API | source client, HTTP cache, advisories | local folder feeds | reading `.nupkg` from disk is a host/IO concern in that extension |
| Project model | project parser, TFM resolver, CPM read/write | workspace globbing, solution restriction, exclude settings | these are `vscode` workspace concerns; reimplementing them drifts |
| Dependency semantics | assets graph, requirement closure, version ranges | `version.ts` primitives | used inside host-side loops and comparators |
| Diagnostics | restore output parsing, failure classifier | spawn context, process execution | spawning, progress and cancellation stay on the host |
| Toolchain | `global.json` edit, SDK analysis | install script, SDK location lookup, workload commands | synchronous host-side resolution and the trust boundary |

Order by **risk × value**: start with a remote API (no file writes, easiest parity), then the
project model (read then write), then semantics, then diagnostics/toolchain. Never start with the
writer: surgical text edits need the golden-file harness you have not built yet.

## 3. Per-wave loop

```
C# implementation
  → MSTest unit tests
  → parity fixture / golden files from the TypeScript implementation
  → wire behind the flag
  → npm run quality + dotnet test
  → delete the TypeScript twin AND its tests in the same PR
  → update the plan file
```

Do not start wave N+1 before wave N's twin is deleted. Two live implementations are how regressions
enter: a bug fixed on one side only, and a parity test that passes because it runs the wrong one.

## 4. Parity techniques, strongest first

1. **Golden files from the old implementation.** Run the TypeScript code over existing fixtures,
   save output, assert byte equality in C#. Required for any writer or formatter — it caught a
   regex bug that emitted a malformed XML tag on the first replacement.
2. **Same fixtures, both suites.** Keep XML/JSON/MSBuild fixtures in a shared test-data folder; the
   TS suite loads them through a path helper, the C# suite walks to the repository root.
3. **Explicit behaviour table.** For non-byte outputs, list caching windows, ordering rules, error
   codes and preference order, and test each in both languages before deleting the twin.
4. **Live smoke test.** Call the real remote API once (network-permitting) — DTO leaks surface
   here, not in unit tests.

## 5. What the port must preserve

- Cache TTLs and invalidation (5-minute package cache, 1-hour advisory cache in the reference).
- Credential scope: attach credentials only for the source host and the hosts its service index
  declares; never globally.
- Decompression (`registration5-gz-*` was gzip).
- Source ordering and exact-version preference.
- Last-match-wins semantics, per-framework grouping, and "do not consolidate across framework
  lines".
- File-write guarantees: validate, apply in memory, verify occurrence counts and versions, refuse
  to overwrite a file that changed while preparing, swap through a temp file.

## 6. Test-seam migration

A host test should test orchestration, not parsing, once the parser is gone:

- Assert the RPC call: method, parameters, scope/condition, ordering, target file.
- Stub the core call in the test (`stubCoreCall`) and record requests.
- Keep pure formatting/redaction on the host and test it there.
- Where a test was really about the ported algorithm, move it to the C# suite with the same
  fixture names — do not delete the coverage.

## 7. Deliberate remainders

Document each one in the plan with a reason and a "moves when" condition. Examples from a finished
migration: `version.ts` (moves when its last consumer moves), `dotnet-context.ts` (synchronous
resolution before every spawn), `sdk-locations.ts` and `sdk-install.ts` (trust boundary),
`local-feed.ts` (local file IO), the clipboard diagnostics report (presentation).

An undocumented remainder will be ported by the next engineer "for consistency" and will regress
something.
