# Plan: C# NuGet core as a sidecar — first slice

**Status:** PROPOSED — awaiting approval
**Branch:** `spike/blazor-wasm-webview`
**Date:** 2026-11-01
**Analysis:** `.ai/analysis/2026-11-01-blazor-wasm-webview-review.md`

## Goal

Move **one** vertical slice of host logic into C#, behind the existing RPC, without changing the
webview, the RPC contract, or the user-visible behaviour:

> NuGet source metadata: search, package versions/dependencies, package details, vulnerability data.

The slice is chosen because it is the part of `src/host` that duplicates something .NET does
better (`NuGet.Protocol`, `NuGet.Versioning`, `NuGet.Frameworks`) and that this repo currently
hand-rolls (576 lines of client + a hand-written SemVer comparator).

## Non-goals (explicitly out of scope)

- No UI change. Lit stays; no Razor, no Blazor, no WASM.
- No change to `src/common/rpc/types.ts` or any RPC signature.
- No CPM writer, no restore diagnostics, no update jobs, no `dotnet` CLI wrapper in C#.
- No local folder feeds in C# v1 — `LocalNuGetFeed` stays TypeScript.
- No contract codegen yet (decide after the slice is proven).
- No DDD layer split (Domain/Application/Infrastructure). One project, clear folders.

## The seam that already exists

`src/host/nuget/api.ts` is a class with four public methods; everything else in the host reaches it
through `nugetApiFactory.GetSourceApiAsync(url)`:

| Method | Returns | Used for |
|---|---|---|
| `GetPackagesAsync(filter, prerelease, skip, take, signal)` | search results | package search |
| `GetPackageAsync(id, prerelease, signal)` | versions + dependency groups | Installed/Updates/dependency graph |
| `GetPackageDetailsAsync(url, signal)` | catalog details | details panel |
| `GetVulnerabilitiesAsync(signal)` | `Map<id, VulnerabilityEntry[]>` | Vulnerabilities tab |

Step 1 turns that class into an interface so a second implementation can be swapped in with no
call-site changes.

## Architecture

```
Extension host (Node)                              Sidecar (C#, one process)
  NuGetApiFactory ──► INuGetSourceApi
                        ├── NuGetApi (TS, today)
                        └── SidecarNuGetApi ──► CoreClient ── NDJSON/stdio ──► NugetPackageManager.Core.dll
                                                                                   NuGet.Protocol
                                                                                   NuGet.Versioning
                                                                                   NuGet.Frameworks
```

- **Transport:** newline-delimited JSON over stdin/stdout. JSON strings escape newlines, so one
  message per line is unambiguous. `stderr` is forwarded to a dedicated output channel.
- **Framing:** `{"id":1,"method":"getPackage","params":{...}}` →
  `{"id":1,"ok":true,"value":...}` / `{"id":1,"ok":false,"error":"..."}`.
- **Handshake:** the sidecar prints `{"ready":true,"protocol":1,"nugetVersion":"..."}` before it
  accepts work; the client fails fast with a clear message otherwise.
- **Concurrency:** requests are matched by `id`; several may be in flight (the Updates scan uses
  concurrency 8). `NuGet.Protocol` v3 resources are safe for concurrent reads.
- **Cancellation:** the host's `AbortSignal` sends `{"id":n,"method":"cancel","params":{"target":id}}`;
  the sidecar cancels its `CancellationTokenSource` and answers `ok:false, error:"cancelled"`.
- **Lifecycle:** started lazily on first use; `restart` up to 3 times on crash; kills its process on
  `deactivate` and on extension-host exit. `windowsHide: true`, no shell.
- **Failure fallback:** if `dotnet` is missing, the runtime is older than 8, or the publish output
  is absent, log once and use the TypeScript `NuGetApi`. A sidecar problem must never break the
  extension.

## Security parity (non-negotiable)

The current client has guards that were added to close real findings. The sidecar must reproduce
them, not approximate them:

1. **Basic auth only for trusted hosts.** Today `_trustedHosts` = the configured source host plus
   the hosts of the service-index resources (`SearchQueryService`, `RegistrationsBaseUrl`,
   `VulnerabilityInfo`). `NuGet.Protocol`'s `PackageSourceCredential` applies credentials per
   source; the sidecar additionally checks each absolute URL it is handed against that same host
   set before attaching `Authorization`.
2. **Credentials never touch argv** (visible in the process list) — they go over stdin and are not
   echoed into logs or error strings.
3. **No `%VAR%` expansion** and no workspace `nuget.config` script execution from C#. Source
   resolution stays in TS (`NuGetConfigResolver` + `PasswordScriptExecutor`), and the sidecar only
   receives the resolved `{url, username, password}`.
4. **URLs validated in TS** before crossing the boundary (`new URL()`), as today.
5. The sidecar does no filesystem writes outside its cache directory and spawns no processes.

## Behaviour parity

- **Error text is produced in TS.** The sidecar returns structured codes
  (`sourceUnreachable`, `packageNotFound`, `unauthorized`, `timeout`, `cancelled`); the adapter maps
  them to the same strings the UI shows today, so no user-visible wording changes.
- **Caching:** preserve the 5-minute package cache and 1-hour vulnerability cache semantics. v1 uses
  an in-process cache in the sidecar plus NuGet's own HTTP caching directory under
  `context.globalStorageUri/nuget-http` (the directory the extension already configures).
- **Version ordering:** `compareVersions` (TS, custom) is replaced by `NuGetVersion` (C#, canonical).
  Known and accepted divergences (build metadata, 4-part versions) are recorded in the parity report;
  behaviour changes are treated as bugs unless they are strictly more correct and documented.
- **Prerelease selection and registration-group selection** keep the same rules (latest stable vs
  latest overall, per-TFM group chosen by `NuGet.Frameworks.FrameworkReducer` rather than the current
  hand-written matcher).

## Build and packaging

- **Layout** (house convention, `.ai/patterns/api-patterns.md`): the `.slnx` at the repo root, with
  the C# projects under `src/` and their test projects under `tests/`. The MSBuild fixtures live in
  `tests/__fixtures__/`, which both props files opt out of explicitly:

  ```
  NugetPackageManager.slnx
  Directory.Build.props                      # nullable, warnings-as-errors, analyzers, RollForward
  src/
  ├── NugetPackageManager.Core/              # C# exe: NDJSON transport + host
  ├── NugetPackageManager.Core.NuGet/        # C# adapter: NuGet.Protocol/Versions/Frameworks
  ├── NugetPackageManager.Core.Workspace/    # C# project model: CPM, projects, frameworks
  ├── NugetPackageManager.VSCode.Common/     # TS project (own tsconfig.json)
  ├── NugetPackageManager.VSCode.Host/       # TS project (own tsconfig.json)
  └── NugetPackageManager.VSCode.Webview/    # TS project (own tsconfig.json)
  tests/
  ├── NugetPackageManager.Core.Tests/           # MSTest — transport + handlers
  ├── NugetPackageManager.Core.NuGet.Tests/     # MSTest — NuGet source adapter
  ├── NugetPackageManager.Core.Workspace.Tests/ # MSTest — project model + CPM
  └── NugetPackageManager.VSCode.Tests/         # Mocha/Sinon (own tsconfig.json)
  ```

  Every project owns a test project named after it, and every TypeScript folder is a
  project: its own `tsconfig.json` extending `tsconfig.base.json`, which owns the
  `@/common`, `@/host` and `@/web` aliases.
  `Directory.Build.props` opts out of `**/__fixtures__/**` so the MSBuild fixtures the
  extension evaluates at runtime keep their own settings.

- **Target framework:** `net8.0` with `<RollForward>LatestMajor</RollForward>`,
  `Nullable=enable`, `TreatWarningsAsErrors=true`, `AnalysisLevel=latest-recommended`,
  `EnforceCodeStyleInBuild=true`. Targeting 8 keeps every 8/9/10/11 runtime in play; roll-forward
  means the user's installed (patched) runtime is what executes. Revisit when .NET 8 usage drops —
  .NET 8 leaves support on 2026-11-10, so this is a deliberate reach-over-recency trade.
- **Publish:** `dotnet publish -c Release -o dist/core` — framework-dependent, no RID,
  `UseAppHost=false`, run as `dotnet dist/core/NugetPackageManager.Core.dll`. Measured: **3.7 MB** for the
  whole output (NuGet client libraries included). No per-RID matrix, no 12.9 MB self-contained
  blob, and `dotnet` is already a documented prerequisite of this extension.
- `.vscodeignore`: `tests/**`, `Directory.Build.props`, `NugetPackageManager.slnx`, `dist/core/**/*.pdb`, `dist/core/**/*.xml`.
- `npm run esbuild` gains no C# step; a separate `npm run build:core` runs the publish above. The
  quality gate runs it when `dotnet` is available and skips with a warning otherwise.

## Steps

### 1. Introduce the interface (TS only)

- Add `INuGetSourceApi` with the four method signatures; `NuGetApi implements INuGetSourceApi`;
  `NuGetApiFactory` returns the interface.
- **Accept:** no call-site changes; `npm run quality` PASS with the existing 434 tests.

### 2. Sidecar skeleton (C# + build)

- `NugetPackageManager.Core` console app: NDJSON loop, `ping`, handshake line, structured errors, `CancellationToken`
  per request, graceful shutdown on stdin close.
- `npm run build:core` publishes to `dist/core`.
- **Accept:** `dotnet build NugetPackageManager.slnx` clean with warnings-as-errors; `dotnet test` green;
  a manual `echo '{"id":1,"method":"ping"}' | dotnet dist/core/NugetPackageManager.Core.dll` round-trips.

### 3. Sidecar client (TS)

- `CoreClient`: spawn, handshake with timeout, request/response matching, cancellation,
  crash detection and bounded restart, stderr → log, dispose on deactivate.
- **Accept:** unit tests with a fake sidecar (a Node script speaking the protocol) covering success,
  protocol error, timeout, crash + restart, repeated crashes, and missing binary. No test spawns
  real .NET.

> `SidecarNuGetApi` moved to step 4: it maps the four methods onto wire shapes that only exist once
> the C# handlers do, so building it first would mean defining those shapes twice, blind.

### 4. Implement the four methods in C#

- `getPackages` → `PackageSearchResourceV3`; `getPackage` → `PackageMetadataResourceV3`
  (versions + dependency groups + downloads + verified); `getPackageDetails` → registration/catalog
  detail; `getVulnerabilities` → `VulnerabilityInfoResourceV3`.
- **Accept:** MSTest tests against a stubbed `HttpMessageHandler` serving recorded v3 index +
  registration + search + vulnerability JSON; mapping asserted against golden files.

> **Resolved during implementation (2026-11-01).** `getVulnerabilities` maps onto
> `IVulnerabilityInfoResource` with exact parity (severity `Low=0 … Critical=3`, one dictionary
> per page, `VersionRange.ToNormalizedString()` matching the feed's own text).
>
> The other three leak NuGet.org registration leaf URLs (`Package.Id`, `Versions[].Id`),
> `Package.Registration` and `Package.Verified`, which `NuGet.Protocol` does not expose. They are
> therefore a faithful port of the registration/search JSON reading instead — the same HTTP +
> JSON the TypeScript does — so the contract stays byte-identical. `NuGet.Protocol` remains for
> advisories, where it is an exact fit. Two behavioural notes: `HttpClient` needs
> `AutomaticDecompression` for the `registration5-gz-*` resources, and the HTTP disk cache is not
> ported yet (the TS side still owns it).

### 5. Parity harness

- A test that runs both implementations over the same recorded feed and diffs the mapped results
  (ordered), with an explicit allow-list file for accepted `NuGetVersion` differences.
- **Accept:** zero unexplained diffs on the fixture; live comparison against nuget.org runs only
  under `VSCODE_NUGET_GALLERY_TEST` (as today).

### 6. Wire behind a flag

- Setting `nugetpackagemanager.useCore` (boolean, default `false`), documented in
  `package.json` and README; activation wires the factory to the sidecar when enabled and available.
- **Accept:** full suite green with the flag off and with the flag on (fixture-backed); panel manual
  check on a real workspace with the flag on — search, install list, Updates, Vulnerabilities.

### 7. Gate, packaging, docs

- Quality gate: add `dotnet build` + `dotnet test` for the C# projects (skipped without `dotnet`).
- `.vscodeignore`, `npm run build:core`, `README.md`, `CHANGELOG.md`, session handoff.
- **Accept:** `npm run quality` PASS with and without .NET installed; `vsce ls` shows
  `dist/core` and no `.pdb`; VSIX size delta recorded.

## Risks

| Risk | Mitigation |
|---|---|
| Sidecar process leaks or crash-loops | bounded restarts, kill on deactivate, per-request timeout, fallback to TS |
| Users without .NET 8+ | net8.0 + `LatestMajor`, detect at activation, fall back to the TS path |
| Subtle behaviour drift (version ordering, group selection) | parity harness + golden fixtures; drift is a bug unless documented |
| Credential handling regression | host-set check before `Authorization`, credentials over stdin only, security review before enabling by default |
| Two test stacks in CI | gate skips gracefully without `dotnet`; CI gets one extra job |
| Slice quietly grows | the interface has exactly four methods; anything else needs a new plan |

## Stop conditions (abandon rather than push through)

- The sidecar cannot be packaged portably (i.e. per-RID builds become mandatory).
- Error semantics cannot be preserved without changing the webview contract.
- The glue (client + protocol) exceeds roughly 200 lines of TS.
- Parity cannot be reached on the recorded fixture within the slice.
- A missing/old runtime cannot fail per feature instead of per activation.

## Rollback

The flag defaults to off, so rollback is: flip `useCore` off, then delete `src/NugetPackageManager.Core*`,
`dist/core` and the client. Nothing in the RPC layer or the UI depends on the slice.

## Effort

Steps 1–4 are the bulk (roughly 4–6 focused days); 5–7 are another 1–2 plus a security review before
the flag can default to `true`.
