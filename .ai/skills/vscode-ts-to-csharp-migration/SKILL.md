---
name: vscode-ts-to-csharp-migration
description: >-
  Convert a TypeScript VS Code extension into a thin Node host plus a .NET sidecar that owns the
  domain logic — the architecture used by NuGet Package Manager. USE FOR: "convert my TS
  extension to C#", "move this extension's logic into .NET", planning waves for a multi-module
  port, adding a JSON-RPC sidecar to an existing extension, deciding what stays TypeScript, porting
  parsers/resolvers/HTTP clients off the extension host, packaging `dotnet` output into a VSIX,
  cutting over from the TypeScript implementation without shipping two implementations. DO NOT
  USE FOR: writing the first VS Code extension, single-function interop, benchmarking an existing
  port (use vscode-csharp-sidecar-benchmark), or UI/webview work.
---

# Converting a TypeScript VS Code extension to a C# sidecar

You cannot replace the extension host. VS Code loads a Node module and exposes no .NET binding for
the extension API. What you *can* do is hollow it out: keep the host as a thin adapter and move
every piece of pure logic — parsers, resolvers, HTTP clients, version semantics, file-format
writers — into a .NET process the host owns.

Target architecture:

```
VS Code extension host (Node/TS)                 .NET sidecar (separate process)
  extension.ts, activation, commands,              domain logic: parsers, resolvers,
  TreeView, status bar, webview, trust             HTTP clients, writers, caches
  CoreClient ──── NDJSON JSON-RPC over stdio ────> NdjsonServer + handlers
       │                                                    │
  Result<T> to the webview                          RpcError { code, message }
```

## What stays where

This playbook is about the **VS Code extension boundary**. `vscode` is importable only from the
extension host; the webview can reach it only through `postMessage`; the sidecar can reach neither.
So a converted extension is a three-hop chain — webview → host RPC → sidecar RPC — and the port is
only correct when the webview cannot tell which hop did the work.

| Stays in TypeScript (extension host), always | Moves to C# (sidecar) |
|---|---|
| `activate`/`deactivate`, `context.subscriptions` | Parsers and format readers (XML, JSON, project files, manifests) |
| Commands, menus, keybindings, `package.json` contributions | Domain resolvers and rule engines (semver, TFM, dependency closures) |
| `TreeView`, `StatusBarItem`, editor decorations, `TextDocument` access | HTTP clients for remote APIs (with caching, retry, decompression) |
| Webview creation, `WebviewPanel`, `postMessage`, nonce/CSP | Text writers / surgical file edits |
| `workspace.getConfiguration`, `context.globalState`/`workspaceState`, `context.secrets` | Classification of captured process output |
| `workspace.isTrusted`, password scripts, any host-side security check | Long computations and caches that outlive a webview |
| `window.withProgress`, `CancellationToken` → `AbortSignal`, child-process spawning | — |

Rules that decide whether the port pays off (they come from a completed migration, not theory):

1. **One RPC per user-level operation.** `getPackages`, `getProjects`, `startConsolidate` — never
   `compareVersions` or `evaluateCondition`. Chatty RPC is slower and more memory-hungry than the
   TypeScript it replaced.
2. **The DTOs do not change.** The webview contract (`types.d.ts`) stays exactly as it is; the
   sidecar emits those shapes. If the contract must change, that is a separate, deliberate change.
3. **The host keeps what only the host can do** — activation, editor state, trust, spawning,
   progress, cancellation.
4. **Each wave ships behind a flag, and the TypeScript twin is deleted in the same PR that flips
   it.** No permanent dual implementation, no "keep it as a fallback".
5. **Primitives stay until their last consumer moves.** `compareVersions`, `isVersionInRange`,
   spawn-context resolution: porting them first means either an RPC in front of every loop or two
   algorithms drifting apart.
6. **Measure the trade.** A port moves work and memory between processes; see
   `vscode-csharp-sidecar-benchmark` before claiming it is faster *and* lighter.

## Phase 0 — inventory before writing code

Run `scripts/inventory.mjs` (bundled) over the extension's TypeScript source. It reports every
module with its line count and whether it imports `vscode`:

```bash
node .ai/skills/vscode-ts-to-csharp-migration/scripts/inventory.mjs <path-to-src>
```

Modules that import `vscode` cannot move. The rest are candidates. In the reference migration this
split 30 host modules into **8 that imported `vscode`** and 22 pure modules worth **≈ 5,775 lines**.

Then write a wave plan, largest coherent domain first, with an explicit table:

| Wave | Modules | Lines | Stays TypeScript because |
|---|---|---|---|
| A — transport | sidecar, client | — | — |
| B — remote API | `api.ts`, `http-cache.ts`, source client | 727 | local folder sources |
| C — project model | parser, TFM resolver, CPM reader/writer | 1,878 | — |
| D — dependency semantics | graph, requirement closure | 462 | shared version primitives |
| E — diagnostics | restore parsing, failure classifier | 455 | spawn context |
| F — toolchain | global.json, SDK analysis | 581 | install/lookup plumbing |

Sequencing rule: **implement in C# → unit tests + parity fixture → wire behind the flag → run the
quality gate → delete the TypeScript twin → update the plan.** No wave starts before the previous
wave's twin is gone.

## Phase 1 — the sidecar skeleton

Create a solution layout with separate projects by responsibility (protocol/handlers, adapters per
third-party library, domain logic), each with its own MSTest project. **Generated projects must fit
the repository's existing layout, analyzer policy and test conventions** — read
`references/csharp-project-conventions.md` before creating the first `.csproj`, and copy the
templates (root `Directory.Build.props` / `Directory.Packages.props`, `Library.csproj`,
`Core.csproj`, `Tests.csproj`, `TestClass.cs`, `Protocol/*`) rather than inventing a layout.

Non-negotiables for anything this skill generates:

- policy settings live in the root `Directory.Build.props`, never repeated per project;
- package versions live in `Directory.Packages.props`, never `Version=` on a `PackageReference`;
- **MSTest only** (xUnit/NUnit are forbidden), one test project per source project;
- `UseAppHost=false` on the sidecar exe, no trimming/R2R (both measured as losses);
- test files carry `// File:` (and `// Traces:` when acceptance criteria exist) and `[TestCategory]`;
- async methods end with `Async` — test methods keep `Method_Scenario_ExpectedResult` instead.

Verify without building:

```bash
node .ai/skills/vscode-ts-to-csharp-migration/scripts/audit-csharp-projects.mjs .
```

```csharp
using var sources = new NuGetSourceProvider();
var handlers = new Dictionary<string, RpcHandler>(StringComparer.Ordinal);
foreach (var (name, handler) in new WorkspaceHandlers(new WorkspaceModelService()).Create())
    handlers[name] = handler;
// ... one foreach per handler group
using var server = new NdjsonServer(Console.In, Console.Out, Console.Error, handlers);
return await server.RunAsync(CancellationToken.None).ConfigureAwait(false);
```

The transport is the part you should copy rather than invent. Requirements:

- **NDJSON framing**: one JSON object per line. JSON escapes newlines inside strings, so framing
  needs no length prefix and survives stdout interleaving with logs written to stderr.
- **Handshake first**: `{"ready":true,"protocol":1,"version":"x.y.z"}` before reading requests.
- **Requests run concurrently and are matched by `id`**; writes are serialized behind one lock.
- **Built-ins**: `ping` and `cancel` (with `{"target": id}`) live in the server, not in handlers.
- **Structured errors, never a dropped request**: `invalidRequest`, `unknownMethod`,
  `invalidParams`, `cancelled`, `internalError`, plus your own domain codes. Catch-all at the
  boundary, log the stack to stderr, answer with a code.
- **A handler is `(JsonElement params, CancellationToken) => Task<object?>`**; throw `RpcException`
  for a structured failure.

`assets/templates/Protocol/NdjsonServer.cs.txt` is a working reference implementation; the wire
types live beside it in the same folder, one type per file.

Project file essentials:

```xml
<TargetFramework>net8.0</TargetFramework>
<UseAppHost>false</UseAppHost>   <!-- framework-dependent, launched as `dotnet App.dll` -->
<RollForward>LatestMajor</RollForward>
```

Set these in the csproj or `Directory.Build.props`. `UseAppHost=false` keeps the package
portable — one build for every OS/arch.

## Phase 2 — the host client

The client owns exactly one child process for the extension's lifetime. Behaviours that are not
optional:

| Behaviour | Why |
|---|---|
| Lazy start on first call, single-flight (`starting` promise) | Activation stays fast; concurrent first calls must not spawn two processes |
| Handshake timeout (e.g. 10 s) | A broken runtime must surface as `unavailable`, not hang activation |
| Per-request deadline that **detaches** | The webview stops waiting; the sidecar keeps working. Timeouts never cancel host work |
| Explicit cancellation via `AbortSignal` → `{"method":"cancel","params":{"target":id}}` | The only way to actually stop work |
| Crash detection + bounded restarts | A dead sidecar is `crashed`, not an unhandled stream error; stop restarting after N |
| stderr forwarded line-by-line to the log | The only diagnostics channel |
| `Dispose()` on deactivate: end stdin, kill | No orphan `dotnet` processes |

`assets/templates/core-client.ts.txt` is the reference client; `core-process.ts` is a thin
singleton that knows where the dll lives (`extensionPath/dist/core/App.dll`) and whether it exists.

**Wire it into activation, not module load.** VS Code activates the extension lazily, so the
sidecar must be configured there and disposed with the extension's lifetime:

```ts
export function activate(context: vscode.ExtensionContext): void {
  coreProcess.Configure(context.extensionPath);       // <extensionPath>/dist/core/App.Core.dll
  context.subscriptions.push({ dispose: () => coreProcess.Dispose() });
  // commands, tree views, webview panels …
}
```

Long host operations map existing VS Code affordances onto the client: `window.withProgress`
drives the UI, the `CancellationToken` becomes an `AbortSignal` passed to `CallAsync`, and the
webview keeps calling the same host RPC it always did.

**Never throw across the RPC boundary.** Handlers return `Result<T>`-shaped values to their
callers (`{ ok: true, value } | { ok: false, error }`); a `CoreError` with a code (`unavailable`,
`crashed`, `timeout`, `cancelled`, domain codes) is a value, not an exception.

## Phase 3 — the contract

Register handler groups by domain, not by helper. Name RPCs after user-level operations. Keep one
wire type per request/response and generate nothing — hand-written types on both sides are cheaper
than a codegen step for a handful of operations, as long as a test pins the shape.

Where a third-party .NET library does not expose fields your DTO already leaks (registration leaf
URLs, `Verified` flags, custom ordering), **port the JSON reading** instead of routing through the
library's higher-level API. The reference migration hit exactly this with `NuGet.Protocol` and kept
the library only where it is an exact fit.

## Phase 4 — port one domain slice

1. **Golden files first.** Run the *TypeScript* implementation over the existing fixtures and save
   its output as expected files. Write the C# tests to compare byte-for-byte. This caught a regex
   bug in the reference migration that inspection missed — surgical text writers must preserve the
   user's bytes exactly.
2. **Port behaviour, not shape.** Same caching windows, same error codes, same preference order,
   same decompression. If the TypeScript decompresses `gzip` responses, configure
   `AutomaticDecompression`.
3. **Keep the same fixtures for both suites.** Put MSBuild/XML/JSON fixtures in a test-data folder
   consumed by both languages, and isolate them from the repo's own central package management.
4. **Expect strictness differences**: `System.Text.Json` and the C# compiler reject things the
   TypeScript tolerated — exhaustive `switch` on enums fights the style analyzer (CS8524 vs
   IDE0072; use `if` chains), nullable flow analysis needs explicit guards, and `.editorconfig`
   naming rules may differ from the class template.
5. **Delete the TypeScript twin and its tests in the same PR.** Update the test seams: a host test
   should assert the RPC call (method, params, ordering) and the C# suite should pin the behaviour.

## Phase 5 — long-running operations

Anything that can exceed a second or two (batch updates, consolidation, cleanup) must not be one
long request:

- `start<Operation>` returns `{ JobId }` immediately.
- `getJob` returns state, stage, percent and the terminal result.
- `cancelJob` aborts explicitly.
- The webview polls (e.g. 250 ms) and stops on completion, error, cancel and disconnect.
- Running jobs are never pruned; preflight the selection before the first write.

RPC deadline and cancellation are different mechanisms — see Phase 2. Getting this wrong produces
"the UI says it failed but the file was written".

## Phase 6 — packaging and runtime

```json
"build:core": "dotnet publish src/App.Core/App.Core.csproj -c Release -o dist/core",
"vscode:prepublish": "node ./esbuild.js && npm run build:core"
```

Ship the **framework-dependent IL build**. Measured in the reference migration (12 interleaved
cold starts, Windows arm64):

| Variant | Output | Cold start | Portable |
|---|---|---|---|
| framework-dependent (chosen) | 4.4 MB, 21 files | 67 ms | any OS/arch with .NET 8+ |
| `PublishReadyToRun` | 11 MB, 20 files | 67 ms | per-RID |
| `PublishTrimmed` + self-contained | 29 MB, 95 files | does not start | per-RID |

- R2R is 2.5× the size and **no faster**: startup is dominated by the `dotnet` host, not JIT of
  your code.
- Trimming disables reflection-based `System.Text.Json`, which the protocol uses for anonymous
  handler payloads. Making it work needs source-generated JSON plus named DTOs everywhere.
- Per-RID builds mean one core per target in the VSIX (~66 MB for a single R2R core) or
  per-platform VSIXes. Only do this if startup is proven to matter.
- `.vsix` must include `dist/core`; `vsce package` does not build it for you.
- A missing runtime surfaces as `CoreError("unavailable")` with a message telling the user to
  install .NET or run the core build. Never let it crash activation.

## Phase 7 — cutover

1. Add a setting such as `<extension>.useCore`, default **off**, at the same time the first wave
   wires in.
2. Both implementations must pass the parity harness on the same fixtures before flipping.
3. Flip the default, run the full gate, then delete the TypeScript implementation in that PR.
4. Remove the flag once the TypeScript twin is gone — a dead switch is a future bug.
5. Keep deliberate remainders explicit and documented (`local-feed.ts`, `dotnet-context.ts`,
   `sdk-install.ts` in the reference migration): they are decisions, not leftovers.

## Phase 8 — verification gate

- C#: `dotnet build` + `dotnet test` (MSTest; the repo forbids xUnit/NUnit).
- TS: typecheck, lint, bundle, unit suite — run through the VS Code test harness
  (`@vscode/test-cli` / `vscode-test`), which executes inside a real extension host, not plain Node.
- Webview tests keep mocking the host API module; host tests stub `CallAsync` and assert the RPC
  (method, params, ordering). Add a fake-sidecar script to cover start/timeout/cancel/crash.
- One command that runs both — the reference gate is `npm run quality`
  (bundles + lint + typecheck + C# build + C# tests + TS tests + audit).
- A change that crosses the sidecar contract needs a core test **and** a host test.
- An opt-in E2E that drives the real sidecar and the real external CLI (`npm run test:e2e`).
- CI needs the .NET SDK installed; if it is missing the gate must skip the core steps loudly, not
  pass silently.

## Pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Chatty RPC | Port is slower than the TS it replaced | One call per user-level operation |
| Timeout cancels work | UI reports failure, file was written | Deadline detaches; cancellation is explicit |
| Two implementations | Fixes land on one side only | Flag + parity + delete the twin in the same PR |
| DTO drift | Webview breaks in one path | DTOs unchanged; the sidecar emits the existing shape |
| Reflection JSON + trimming | Sidecar starts then dies | Do not trim; or source-generate every payload |
| Stale `dist/core` | Local build behaves like an old version | `npm run build:core`; check the publish output timestamp |
| Orphan processes | `dotnet` processes accumulate | Dispose ends stdin and kills; kill on handshake failure |
| Missing runtime in CI | Gate fails on unrelated PRs | Document the prerequisite; make the gate skip with a warning |
| Fixtures inherit repo CPM | C# tests resolve unexpected versions | Isolate test data with its own `Directory.Packages.props` (`ManagePackageVersionsCentrally=false`) |
| Porting primitives first | RPC in front of every loop | Move a primitive only when its last consumer moves |
| Synchronous spawn context | Extra latency before every process spawn | Keep `dotnet`/PATH resolution in TS |
| Unbounded memory in the sidecar | RSS climbs with project count | Caches with caps and invalidation, like the TS version had |

## Checklist

- [ ] Inventory run; movable lines counted; wave table written
- [ ] Root `Directory.Build.props` and `Directory.Packages.props` in place; no policy or version
      duplicated in a project file
- [ ] Every generated project registered in the `.slnx`; each source project paired with
      `tests/<Name>.Tests`; test files carry `// File:` and `[TestCategory]`
- [ ] Guardrail audit clean (`audit-csharp-projects.mjs`) before the first build
- [ ] Sidecar skeleton: handshake, ping, cancel, structured errors, stderr
- [ ] Client: lazy single-flight start, handshake timeout, detach-on-deadline, AbortSignal cancel,
      bounded restarts, stderr forwarding, dispose
- [ ] Contract: one RPC per user-level operation, DTOs unchanged, error codes enumerated
- [ ] Golden files captured from the TypeScript implementation before porting
- [ ] First wave wired behind a flag; parity harness green
- [ ] Long operations converted to start/get/cancel jobs with polling
- [ ] `dotnet publish -o dist/core` in `vscode:prepublish`; core in the VSIX
- [ ] Framework-dependent build; no trimming; no per-RID unless measured
- [ ] Quality gate runs both languages; CI has the SDK or skips loudly
- [ ] Every TypeScript twin deleted with its tests; flag removed
- [ ] Deliberate remainders documented
- [ ] Before/after measured with `vscode-csharp-sidecar-benchmark`

## Resources

- `references/architecture-and-transport.md` — process model, transport, client lifecycle, error model
- `references/porting-waves.md` — inventory method, wave planning, what stays TypeScript, test seams
- `references/packaging-and-cutover.md` — publish modes, VSIX contents, runtime prerequisites, flag discipline
- `references/csharp-project-conventions.md` — layout, root build policy, csproj rules, naming, MSTest conventions, forbidden packages, audit
- `assets/templates/Directory.Build.props.txt`, `Directory.Packages.props.txt` — root policy and central versions
- `assets/templates/Core.csproj.txt`, `Library.csproj.txt`, `Tests.csproj.txt` — project files
- `assets/templates/Program.cs.txt` — composition root
- `assets/templates/TestClass.cs.txt` — MSTest class with the required header and naming
- `assets/templates/Protocol/` — `NdjsonServer`, `RpcRequest`, `RpcResponse`, `RpcError`, `RpcException`, `ProtocolJson` (one type per file)
- `assets/templates/core-client.ts.txt` — reference host client
- `scripts/inventory.mjs` — module inventory and `vscode`-import report
- `scripts/audit-csharp-projects.mjs` — layout/rules/guardrail audit for generated C# projects
