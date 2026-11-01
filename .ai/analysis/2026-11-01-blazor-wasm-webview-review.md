# Review: convert the webview to Blazor WebAssembly + TypeScript bridge

**Date:** 2026-11-01
**Branch:** `spike/blazor-wasm-webview`
**Status:** Analysis only — no code changed
**Author:** Reasonix Code

## The proposal

Replace the Lit webview with a Blazor WebAssembly app, keep the TypeScript extension host as a
"bridge" to VS Code, and preserve the current look and feel.

## Verdict

**Technically possible, but a net negative for this project as it stands.** It adds a second
runtime and a second toolchain, requires rewriting ~11k lines of working UI and all of its tests,
removes none of the 19.7k lines of host code, and depends on a VS Code URL quirk that Microsoft
has explicitly declined to fix. The single real upside — reusing .NET libraries — is better
obtained with a .NET sidecar, not by moving the UI to WASM.

A small spike is still worth running **if** the goal is proven, because the failure modes are
concrete and cheap to test. A full port should not be planned until the spike passes.

---

## 1. What the proposal actually changes

The extension host cannot be written in C#: VS Code loads extensions as Node.js modules via
`package.json` → `main`, and there is no .NET binding for the extension API. So the split becomes:

| Layer | Today | After the proposal |
|---|---|---|
| Host (VS Code API, `dotnet` CLI, NuGet HTTP, CPM) | TypeScript, 70 files / 19,722 lines | **Unchanged TypeScript** + bridge shim |
| RPC contract | `src/common/rpc/types.ts`, 36 methods / 74 exported types | Duplicated: TS + C# DTOs |
| UI | Lit, 41 files / 14,841 lines (11,065 non-test) | Razor, new codebase |
| Web tests | 12 files / 3,776 lines, Mocha + jsdom | bUnit/xUnit, new codebase |
| Build | esbuild, ~1 s | esbuild + `dotnet publish` (WASM) |
| Test runner | `vscode-test` (Mocha) | `vscode-test` **plus** `dotnet test` |

So this is not a port of the project; it is a port of **one third of it**, after which the project
is permanently polyglot. Every RPC addition then has to be made twice (TS contract + C# mirror).

## 2. Feasibility: five hard constraints

### 2.1 VS Code's `+` in the resource hostname (the blocker)

VS Code builds webview resource origins as `SCHEME+AUTHORITY.vscode-resource.vscode-cdn.net`.
`System.Uri` rejects `+` in a hostname:

```
System.UriFormatException: Invalid URI: The hostname could not be parsed.
```

This is [microsoft/vscode#163225](https://github.com/microsoft/vscode/issues/163225). VS Code
closed it as **out of scope** ("this is a framework specific problem"), the author never submitted
the proposed fix, and the change never landed. Any code path in Blazor that parses the document
base URI through `System.Uri` fails on stock VS Code.

### 2.2 Blazor validates base URI at startup

[dotnet/aspnetcore#26790](https://github.com/dotnet/aspnetcore/issues/26790) — "Allow Blazor wasm
in vscode webview from extension" — was closed **won't fix**. `NavigationManager` throws when the
document location is not contained by the base URI, and relative `<a href>` navigation points at an
external, invalid URI. Microsoft's own sample,
[MackinnonBuck/vscode-webview-blazor](https://github.com/MackinnonBuck/vscode-webview-blazor), still
tells you to **build a custom VS Code** from the `rrelyea/vscode` branch
`dev-rrelyea-schemeAuthorityDelimiter` to run it.

### 2.3 The only known workaround is undocumented-ish and fragile

The Microsoft engineer's advice on #26790 was: **do not set `<base href>`**, use absolute URIs for
static assets, and override boot resources (`loadBootResources` / `loadBootResource`) so
`blazor.boot.json` and the `_framework` files are fetched from `webview.asWebviewUri(...)`.
The older workaround — patching `getLocationHref` to return `document.baseURI` inside
`blazor.webassembly.js` — monkey-patches framework internals and will break on a .NET upgrade.

Consequences for this app even if boot succeeds:

- The app must be a **single page with no routing**. That is compatible with the current tabbed UI,
  but it forecloses deep links / `@page` routes later.
- Every asset reference must be absolute and generated host-side — no plain relative paths.
- The boot path is unsupported by Microsoft and can change in any .NET servicing release.

### 2.4 CSP

The webview HTML in `src/host/extension.ts` ships:

```
default-src 'none'; script-src 'nonce-...'; ... connect-src 'none'; base-uri 'none'
```

Blazor WASM needs at least:

- `script-src 'nonce-...' 'wasm-unsafe-eval'` (WASM compilation),
- `connect-src ${webview.cspSource}` (boot config + 43 framework fetches),
- possibly `worker-src`/`child-src` for the runtime's workers.

Widening `connect-src` from `'none'` to the webview source is a real (if small) security-posture
change and needs a council decision per `.ai/reference/council.md`.

### 2.5 Static file serving / compression

`dotnet publish` emits `_framework` with raw + `.br` + `.gz` siblings; ASP.NET Core serves the
compressed variant via `Accept-Encoding` + `Content-Encoding`. A VS Code webview static-resource
loader is not ASP.NET Core, so nothing will set `Content-Encoding`; Blazor would receive brotli
bytes where it expects WASM. The practical options are:

- ship only the **raw** files (~9.2 MB for the framework), or
- intercept every boot resource and decompress in JS (`DecompressionStream`) — more custom code on
  the unsupported path.

## 3. Measured cost

Measured on this machine (`.NET SDK 10.0.403`, `wasm-tools` 11.0.100-rc.3), stock
`dotnet new blazorwasm --framework net10.0` + `dotnet publish -c Release`:

| Metric | Value |
|---|---|
| Publish output `wwwroot` | **28 MB**, 275 files |
| `_framework` only, raw | **9.22 MB** (43 files) |
| `_framework` only, brotli | 2.76 MB |
| `_framework` only, gzip | 3.53 MB |
| Largest file | `dotnet.native.wasm` 2.90 MB (0.93 MB br) |
| ICU data (can be dropped with `InvariantGlobalization`) | 1.11 MB + 0.96 MB |

Current extension for comparison:

| Metric | Value |
|---|---|
| `dist/` | 6.0 MB (`web.js` 388 KB, `web.css` 102 KB) |
| `releases/nugetpackagemanager-2.2.0.vsix` | **8.7 MB** |

Realistic outcome: **+9 to +12 MB of VSIX**, roughly doubling the download, plus a cold-start cost
of booting the Mono runtime in a webview before the first pixel of UI (not measured here; expect
several hundred ms, on every panel creation unless `retainContextWhenHidden` saves it).

Also to re-implement or bridge: Split.js (`packages-view.ts`), the generated codicon stylesheet
(1,674 lines), the dropdown, focus trap/dialog, and virtualized package lists. CSS variables keyed
to the VS Code theme carry over cleanly, so *visual* parity is achievable — but it is a manual,
per-component rewrite, not a styling exercise.

## 4. What it buys, honestly

**Does buy**

- A single Razor component library if a second UI host (Visual Studio extension, MAUI/Blazor
  Hybrid, or a standalone desktop app) is a real roadmap item. This is the strongest argument for
  the idea — Blazor Hybrid in a VSIX/WebView2 is a supported Microsoft path; Blazor WASM in a VS
  Code webview is not.
- A C#-first contributor experience, if that matters more than the technical costs.
- Access to `NuGet.Versioning` / `NuGet.Protocol` / `NuGet.Configuration` **in the UI process** —
  but the UI does not need them, and they cannot touch the file system or spawn `dotnet` from WASM.

**Does not buy**

- Any user-visible feature.
- Any reduction in TypeScript: the host stays, and the RPC contract is duplicated.
- Faster rendering. Interpreted Mono is generally slower than the current Lit code for DOM-heavy
  lists; enabling WASM AOT adds build time and tens of MB.
- Simpler security. It widens CSP and adds middleware-ish boot customization.
- Fewer tests. It replaces 12 web test files with a second test stack.

## 5. Alternatives, ranked

### A. Keep Lit/TS; add a .NET sidecar only where .NET is genuinely better (recommended)

If the underlying motivation is "stop hand-rolling NuGet/MSBuild logic", keep the UI and the RPC
layer intact and add a small C# helper (e.g. `dotnet tool` or framework-dependent executable) that
the host invokes over stdio/JSON. It can own `NuGet.Protocol`, `NuGet.Configuration`,
`NuGet.Versioning`, and real MSBuild evaluation, while the TypeScript host keeps workspace trust,
path validation, and the VS Code API. Cost is bounded, reversible, and testable per-feature; the
extension already requires `dotnet` on PATH, so no new runtime is introduced.

### B. Spike Blazor WASM, then decide

A 1–2 day, throwaway spike that answers only: *does a Blazor app boot and render in stock VS Code
1.110+ under the tightened CSP, with no base href and absolute boot resources?* If it needs a
patched VS Code or a framework monkey-patch, stop there. If it boots cleanly, the remaining work is
a normal (large) port and can be planned on evidence.

### C. Full port

Only justified if (B) passes **and** a second UI host is committed. It is a multi-week rewrite of
the UI and its tests that freezes feature work, with a permanent polyglot maintenance cost.

### D. Drop the idea

Keep the current architecture; spend the effort on features (the roadmap has open items around
NuGet library correctness, toolchain diagnostics, and update reliability).

## 6. Recommendation

1. Do **not** start a full port now.
2. If the idea is still attractive, run **B** as a time-boxed spike on this branch, with an explicit
   stop condition (custom VS Code or internals patch required → abandon).
3. If the real goal is .NET library reuse, choose **A** and write a plan for the sidecar.
4. Any option that changes the webview runtime or widens CSP is an architecture/security decision
   and should go through the council process (`.ai/reference/council.md`) before implementation.

## 7. Sources

- microsoft/vscode#163225 — `+` in webview resource hostname; closed out-of-scope, no fix merged.
- dotnet/aspnetcore#26790 — Blazor in VS Code webview; closed won't-fix.
- MackinnonBuck/vscode-webview-blazor — sample; requires a custom VS Code build.
- ASP.NET Core docs — CSP for Blazor (`script-src ... 'wasm-unsafe-eval'`), boot resource loading,
  `InvariantGlobalization`, Blazor WASM AOT.
- Local measurements: `dotnet new blazorwasm` + `dotnet publish -c Release` (scratch, not in repo);
  `du -sh dist`, `releases/*.vsix`.
- Repository: `src/common/rpc/types.ts`, `src/host/extension.ts` (CSP), `package.json`.

---

# Part 2 — Review of the four alternative routes

**Added:** 2026-11-01, after a second opinion proposed four routes (C# kernel as sidecar;
`Microsoft.JavaScript.NodeApi` in-process; .NET WASM in the extension host; Blazor Server in an
iframe).

## 2.0 The list conflates three independent decisions

The four routes are not alternatives to each other. They are combinations of three orthogonal
choices, and only two of the four are real forks:

| Decision | Options | Routes using it |
|---|---|---|
| Where does the logic live? | TS host / C# core | 1, 2, 4 move it; 3 only for pure functions |
| How does TS reach the C# core? | stdio/JSON subprocess / in-process N-API / localhost HTTP | 1 = subprocess, 2 = N-API, 4 = HTTP |
| Where does the UI render? | Lit (today) / Razor | only 4 moves it |

Route 3 is a transport with no filesystem and no process spawning, i.e. it cannot host the code
that actually needs porting. It is not a route, it is a dead end for this project.

So the real decision set is: **(A)** port logic to C# at all, **(B)** if yes, subprocess vs
in-process, **(C)** move the UI or not. Answer A first; B and C only matter once A is yes.

## 2.1 Route 1 — C# core as a sidecar, TS as adapter (agree)

This is the same conclusion Part 1 reached independently (alternative A), and the convergence is
worth noting. It is the lowest-risk of the four because each piece is separately testable and
reversible.

**True in the proposal**

- Contract-first generation works: Reinforced.Typings (MSBuild task, actively maintained) or
  TypeGen generate TS interfaces/enums from C#. NSwag is the wrong tool here — it is
  OpenAPI-oriented, and this is `postMessage` RPC, not REST.
- The compiler-enforced rules are real and stronger than the current lint-only equivalents:
  nullable reference types, `TreatWarningsAsErrors`, `AnalysisLevel`, CS4014 (unawaited async),
  VSTHRD110 (observe async results). The repo's existing conventions — `Async` suffix, never throw,
  `Result<T>` — already read like C# conventions, so the port is culturally cheap.
- "The core is plain xUnit, no VS Code, no webview" is correct and is the main prize.

**Understated or wrong**

- **Codegen does not remove all duplication.** Codegen tools emit classes/interfaces, not TS
  discriminated unions. `Result<T> = { ok: true; value: T } | { ok: false; error: string }` and the
  job/union responses (`GetJobResponse` discriminated by `Kind`) will need a hand-maintained
  generic wrapper and custom templates. Realistic outcome: generated DTOs + hand-written method
  signatures for 36 methods.
- **"C# is the single source for all 36 methods" is not achievable and should not be a goal.**
  A large share of the surface is pure VS Code: `openExternal`, workspace trust, settings,
  telemetry, status bar, TreeView refresh, the inline version decorator. Those must stay TS. The
  contract splits into a C#-generated domain half and a hand-written VS Code half — plan for two
  files, not one.
- **Security guards are not part of the port and must be re-earned.** The hard-won fixes (realpath
  path containment, machine-scoped script allowlist, no `%VAR%` expansion, credential origin
  scoping, validated versions before XML writes) live in TS. A C# core receives the same
  attacker-controlled workspace input. Either keep validation in the TS adapter before crossing the
  boundary, or port it and re-run the security review — not neither.
- **The DDD layer split (Domain/Application/Infrastructure) is a redesign, not a port.** The
  volume in `src/host` is XML parsing, `dotnet` spawning and HTTP. Adopt the cheap wins first
  (nullable, analyzers, warnings-as-errors, architecture tests) and treat layering as a separate,
  later decision with its own justification.
- **Scope**: route 1 as written means moving ~19.7k lines. Start with the slice that pays.

**Sizing (measured here)**

- Framework-dependent sidecar: negligible size, but requires a .NET runtime on the machine — fine
  for this audience, already a documented prerequisite, but needs a version check and a clear
  error path (GUI-launched VS Code on macOS often has no `dotnet` on `PATH`; today that degrades
  per-feature, with a sidecar it can degrade per-activation).
- Self-contained, trimmed, single-file: **12.9 MB for one RID** (measured: `dotnet new console`,
  `dotnet publish -r win-x64 --self-contained -p:PublishTrimmed -p:PublishSingleFile`). Six RIDs
  (win/linux/osx × x64/arm64) means either ~78 MB in one VSIX or platform-specific VSIXes via
  `vsce package --target`.

## 2.2 Route 2 — `Microsoft.JavaScript.NodeApi` in-process (promising, unproven here)

Facts checked: the repo is `microsoft/node-api-dotnet` (the proposal's link), it is **active**
(last commit 2026-10-31, .NET 10 support merged), and it is **Public Preview** with "minor breaking
API changes" still expected. It is N-API based, so "compatible with any Node.js version without
recompiling" — which is why it is plausible inside Electron's extension host.

**What it would buy**: no IPC hop, no process lifecycle, generated TS definitions from C#.

**What the proposal correctly flags as unverified, plus what it missed**

- It is a **native addon**, so the VSIX must ship prebuilt binaries per platform/arch (or be
  published as platform-specific targets). That is packaging work the subprocess route also has,
  but here a mismatch crashes activation instead of failing one feature.
- It **loads the .NET runtime into the extension host**. That turns "dotnet is needed for these
  features" into "dotnet is needed for the extension to activate", and a runtime-load failure takes
  the whole extension down with it — worse failure mode than a sidecar that dies on one request.
- Public Preview + Electron is exactly the kind of combination that needs the probe the proposal
  asks for. Agreed: probe before betting.
- **It solves a problem that does not exist yet.** The RPC is coarse-grained (36 methods, jobs
  polled at 250 ms). One extra process hop per call is not a bottleneck at this granularity. Route
  2 is an optimization for a latency problem that has not been measured.

## 2.3 Route 3 — .NET WASM inside the extension host (reject)

- Loses the two things the core actually needs: filesystem access and `dotnet` process spawning.
  What remains is pure functions — which are the cheapest part to port or leave in TS.
- Ships the same payload Part 1 measured (`_framework` 9.22 MB raw) into the extension, with Mono
  startup on activation.
- No interop story with the VS Code API; you still need the TS layer.
- The only thing it avoids is the webview `+` hostname problem — by removing the webview, i.e. by
  not solving the actual problem.

## 2.4 Route 4 — Blazor Server in the sidecar, iframed in the webview (conditional)

Technically credible, and it does dodge the WASM blockers (no Mono download in the webview, no
`System.Uri` on `vscode-webview://`). Real advantages: server-side rendering is fast, bUnit tests
components, debugging is normal .NET.

**What it costs beyond route 1**

- **A listening socket.** Loopback-only plus a per-session token, and a strict origin check. That
  is a new, persistent attack surface in a security-sensitive extension, and it goes through the
  same council gate as the WASM CSP change.
- **CSP still changes**: `frame-src` must allow the resolved origin, so "het wijzigt de
  CSP-houding net zoals bij WASM" applies here too — it is not a neutral option.
- **Remote workspaces.** The webview runs on the client; the extension host (and therefore the
  sidecar) runs on the remote. `127.0.0.1` is then the wrong machine. You need `asExternalUri` to
  get a forwarded URI per workspace, plus `frame-src` for that origin. This works, but it is extra
  machinery and a class of bugs the current extension never has.
- **Lifecycle**: one server per window, dynamic port allocation, port handshake to the webview,
  circuit loss on webview reload, orphan cleanup on crash/deactivate, and firewall/AV prompts on
  Windows.
- **Theming**: CSS custom properties do not cross an iframe boundary; every VS Code variable has to
  be injected and kept in sync (the proposal notes this — it is more work than it sounds, because
  `packages-view` uses dozens of them, plus `data-vscode-theme-kind`).
- Native UI (TreeView, commands, status bar, decorators) stays TypeScript regardless.

**When it is worth it**: only if "the UI must be testable in C# with bUnit" is a hard requirement
*and* there is no plan for a second host. If the real goal is a second host, go to Blazor
Hybrid/WebView2 for Visual Studio, where none of this applies.

## 2.5 Cross-cutting costs all four routes underweight

1. **Two-language debugging and observability** — crash diagnostics, log correlation across the
   boundary, and the quality gate (ESLint + SonarJS + `tsc` + `audit` today) must grow a .NET leg
   (analyzers, `dotnet test`, coverage) without doubling CI wall time.
2. **CI matrix** — every route except the framework-dependent subprocess needs per-RID builds
   (and, for route 2, per-RID native artifacts).
3. **Failure UX** — a missing/old .NET runtime must degrade per feature, not per activation.
4. **`.ai/` context** — 102 skills, 9 agents, all of `AGENTS.md` are written for a TypeScript
   project. A polyglot core invalidates the agent/delegation table and most coding rules.
5. **Migration risk** — the host carries subtle, hard-won behaviour (per-TFM CPM resolution,
   NU1107/NU1605 attribution, single-restore transactional batches, job cancellation). A port that
   loses any of it is a regression the test suite will only partly catch, because 35 host test
   files encode the current shape.

## 2.6 Recommended sequence (staged, each step independently shippable)

0. **Keep Lit and the TS host.** No UI move. This is the default for every step below.
1. **Extract one vertical slice to C#**, chosen for value, not for symmetry: NuGet metadata +
   version resolution (`src/host/nuget/api.ts` is 576 lines of hand-rolled client, plus SemVer and
   framework-alignment logic). Ship it as a framework-dependent `dotnet tool`-style executable
   behind the existing RPC; JSON over stdio. Add xUnit + analyzers + architecture tests for the new
   project only.
2. **Measure.** Compare cold start, failure modes, and maintenance against the TS implementation.
   Do not touch the second slice until this one has run for a release.
3. **Only then** decide whether to move more (CPM writer, restore diagnostics) and whether the
   contract should be generated from the C# side.
4. **Never move the UI** unless a second host is committed. If it is, target Blazor Hybrid/WebView2
   for that host and keep Lit for VS Code.

Stop conditions (abandon rather than push through): the slice cannot be packaged for all RIDs
without a per-platform VSIX; the runtime dependency cannot fail gracefully; the stdio contract
needs more than ~200 lines of glue; or error semantics (`Result<T>` + string errors) cannot be
preserved without changing the webview.

## 2.7 Where this leaves the original question

Unchanged: **do not port the UI to Blazor WASM.** Route 1, reduced to a slice, is the only option
here that pays for itself. "De logica in C# houden met regels die de compiler afdwingt" is a
legitimate goal, and it is achievable without moving a single pixel.
