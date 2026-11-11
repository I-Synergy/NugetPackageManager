# CLAUDE.md

> Canonical agent guide: [`AGENTS.md`](AGENTS.md). This file keeps the project-specific
> engineering detail used by Claude Code. AI working context lives in `.ai/`.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Identity

This is **NuGet Package Manager** — a VS Code extension for browsing, installing, updating, and auditing NuGet packages across .NET projects. It is a **dual-language repository**: a **.NET / C# core** (`src/NugetPackageManager.Core*`, run as a sidecar from `dist/core`) and a **TypeScript / Node.js extension** (`src/NugetPackageManager.VSCode.*`, VS Code host + Lit webview). Neither half is legacy.

## Build & Development Commands

```bash
npm run esbuild          # Build (dev) - compiles host + web bundles
npm run build:core       # dotnet publish the C# sidecar to dist/core
npm run typecheck        # tsc over src and the TS test project
npm run lint             # Check code style (ESLint 9 flat config)
npm run lint:fix         # Auto-fix linting issues
npm test                 # Run TypeScript tests (VSCode Test CLI + Mocha)
npm run test-compile     # Compile tests only (tsconfig.test.json)
npm run test:e2e         # End-to-end: real sidecar + real dotnet against a fixture project
dotnet build NugetPackageManager.slnx -c Release   # C# core
dotnet test  NugetPackageManager.slnx -c Release   # MSTest
npm run quality          # Full gate: bundles, lint, typecheck, C# build + tests, TS tests, audit
npm run package          # Package extension (.vsix) into releases/
```

Build produces two separate TypeScript bundles via `esbuild.js`:
- **Host**: `src/NugetPackageManager.VSCode.Host/extension.ts` → `dist/extension.js` (Node.js, CommonJS)
- **Web**: `src/NugetPackageManager.VSCode.Webview/main.ts` → `dist/web.js` (Browser, ESM)

and publishes the .NET sidecar to `dist/core` (`NugetPackageManager.Core.dll`).

`NugetPackageManager.slnx` also lists the TypeScript entry points and configuration under
`/TypeScript*/` solution folders, so Visual Studio shows both halves of the repository. They are
solution items, not MSBuild projects: `dotnet build` ignores them and the TypeScript still builds
with `npm run esbuild` / `npm run quality`.

## Environment

- **Platform**: Windows 11 (paths use backslashes internally; use forward slashes in shell commands)
- **Shell**: bash via Git Bash / MSYS2 (use Unix syntax: `/dev/null`, forward slashes)
- **Node.js**: v19+ required (for `globalThis.crypto.randomUUID()`)
- **dotnet CLI**: must be on PATH for install/update/restore operations

## Architecture

### Dual-Process Model

The extension runs in two separate contexts communicating via `postMessage`, and delegates the NuGet
domain to a .NET sidecar:

```
VSCode Extension Host (Node.js)          VSCode Webview (Browser)
  src/NugetPackageManager.VSCode.Host/extension.ts    src/NugetPackageManager.VSCode.Webview/main.ts
  RpcHost (postMessage)  <-- RPC -->       RpcClient (acquireVsCodeApi)
  host-api.ts                               components/*
        │
        │ sidecar JSON-RPC over stdio (nuget/core-process.ts, nuget/core-client.ts)
        ▼
.NET core (dist/core, net10.0)
  src/NugetPackageManager.Core            protocol + handlers
  src/NugetPackageManager.Core.NuGet      source client, config, advisories
  src/NugetPackageManager.Core.Workspace  csproj model, CPM, TFMs, dependency graph
```

### Typed RPC Layer (Core IPC)

All host-web communication uses a **typed RPC layer** with `Result<T>`:

- **HostAPI interface** in `src/NugetPackageManager.VSCode.Common/rpc/types.ts` — defines all methods with typed request/response
- **Result<T>**: Discriminated union `{ ok: true, value: T } | { ok: false, error: string }`
- **Wire protocol**: `{ type: 'rpc-request', id, method, params }` / `{ type: 'rpc-response', id, result }`
- **RpcHost** (`src/NugetPackageManager.VSCode.Common/rpc/rpc-host.ts`): Host-side dispatcher mapping method names to HostAPI
- **RpcClient** (`src/NugetPackageManager.VSCode.Common/rpc/rpc-client.ts`): Client-side ES Proxy, 120s request deadline, Promise-based. The deadline only stops the webview waiting — it never cancels host work (cancellation is explicit, via `AbortSignal`).
- **Host implementation** in `src/NugetPackageManager.VSCode.Host/host-api.ts`: All handlers as functions returning `Result<T>`

### Real-time Progress

Long mutations run as host-side jobs, not as request/response calls:

- `OperationJobs` (`src/NugetPackageManager.VSCode.Host/utilities/operation-jobs.ts`) — a `JobRegistry` per kind (`batchUpdate`, `projectUpdate`, `consolidate`, `cleanup`) holding state, stage, percent and the terminal `Result`; running jobs are never pruned.
- `startBatchUpdateAsync` / `startProjectUpdateAsync` / `startConsolidateAsync` / `startCleanupAsync` return `{ JobId }` immediately; `getJobAsync` polls state and `cancelJobAsync` aborts explicitly. The old single-call RPCs remain and delegate to the same implementations.
- `src/NugetPackageManager.VSCode.Webview/jobs.ts` — `waitForJobAsync` plus typed runners (`runProjectUpdateJobAsync`, …) used by `updates-view`, `project-row`, `packages-view`, `consolidate-view` and `cleanup-view`. Each runner takes `onStarted(jobId)` so the owning component can offer `cancelJobAsync` while it runs.
- `checkBatchUpdateAsync` preflights a selection against `project.assets.json` + NuGet metadata (`findBatchUpdateConflictsAsync`) before any write; `BatchUpdateResponse.ConflictingPackages` maps a failed restore's diagnostics back to the offending rows.
- `TaskExecutor.ExecuteCommandAsync` in `src/NugetPackageManager.VSCode.Host/utilities/task-executor.ts` still spawns dotnet and parses stdout into progress stages (`Map<string, OperationProgress>`), exposed through `getOperationProgressAsync`.

### Web Components (Lit)

UI uses **Lit** (LitElement) with native HTML elements styled via VS Code CSS variables:

- `@customElement("tag-name")` decorator for components
- `@state()` for internal reactive state, `@property()` for external attributes
- Template syntax: `html` literals, `.prop` (property binding), `?attr` (boolean attr), `@event`
- Module-level singletons in `src/NugetPackageManager.VSCode.Webview/registrations.ts`: `hostApi`, `router`, `configuration`

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `packages-view` | `src/NugetPackageManager.VSCode.Webview/components/packages-view.ts` | Main 3-pane layout (project tree / packages / details) with Split.js |
| `project-tree` | `src/NugetPackageManager.VSCode.Webview/components/project-tree.ts` | Checkbox tree for project selection |
| `updates-view` | `src/NugetPackageManager.VSCode.Webview/components/updates-view.ts` | Outdated packages tab — auto-refreshes on tab switch |
| `consolidate-view` | `src/NugetPackageManager.VSCode.Webview/components/consolidate-view.ts` | Version inconsistency finder — auto-refreshes on tab switch |
| `vulnerabilities-view` | `src/NugetPackageManager.VSCode.Webview/components/vulnerabilities-view.ts` | CVE scanning — auto-refreshes on tab switch |
| `search-bar` | `src/NugetPackageManager.VSCode.Webview/components/search-bar.ts` | Search + source + prerelease filter |
| `package-row` | `src/NugetPackageManager.VSCode.Webview/components/package-row.ts` | Package list item |
| `project-row` | `src/NugetPackageManager.VSCode.Webview/components/project-row.ts` | Per-project install/update/uninstall UI with progress bar |

### Path Alias

`@/*` resolves to `src/*` (configured in `tsconfig.json`, resolved by `esbuild`).

## Testing

Tests use **VSCode Test CLI** with Mocha (bundled in `@vscode/test-cli`) + Sinon + Node.js assert;
the C# projects use MSTest:

- TypeScript test files: `tests/NugetPackageManager.VSCode.Tests/**/*.test.ts` (mirrors the `src/NugetPackageManager.VSCode.*` layout)
- C# test projects: `tests/NugetPackageManager.Core.Tests`, `.Core.NuGet.Tests`, `.Core.Workspace.Tests`
- Mocking: Sinon sandboxes for VSCode API, Axios, file system
- Test config: `tsconfig.test.json` (CommonJS override for Node.js execution)
- Pattern: Arrange with stubs → Act via component method → Assert with `assert.strictEqual`
- Web component tests: Mock `hostApi` via `Object.defineProperty(registrations, 'hostApi', { value: mock })`
- Lit updates: Use `await element.updateComplete` instead of manual DOM tick
- E2E: `tests/NugetPackageManager.VSCode.Tests/e2e/*.e2e.ts` run through the `e2eTests` label
  (`npm run test:e2e`) with the real sidecar and the real `dotnet` CLI

Run a single test file by modifying `.vscode-test.js` config or using the test explorer.

## Central Package Management (multi-framework)

`CpmResolver` in the .NET core (`src/NugetPackageManager.Core.Workspace/Cpm/`) resolves package
versions per project and target framework:

- Conditions (`<ItemGroup Condition="...">`) are evaluated by `CpmCondition.cs` against the
  project's real TFMs (`TargetFrameworkResolver.cs`, `dotnet msbuild -getProperty`).
- Negated conditions are labels (`not net11.0`); one version line per condition.
- `CpmWriter.cs` applies all changes for one props file in a single read/write, verifies before
  writing, and scopes writes to the addressed `ItemGroup`. The host adapters are
  `utilities/cpm-reader.ts`, `utilities/cpm-writer.ts` and `utilities/cpm-conditional.ts`.
- Runtime-aligned packages stay on the TFM's major line (`net10.0` → 10.x) unless the user
  explicitly chooses the overall latest.
- Installed, Updates, Consolidate and Vulnerabilities must share the same per-TFM resolution.

Details: `.ai/project/architecture.md`, `README.md` → *Multi-framework version management*.

## Code Conventions
- **Strict TypeScript**: `strict: true`, avoid `any` (warn-level in ESLint)
- **Unused vars**: Prefix with `_` to suppress warnings
- **Error responses**: RPC methods return `Result<T>` — use `ok(value)` / `fail(error)` helpers
- **Styling**: CSS-in-JS via Lit `css` tagged template literals, using VS Code CSS variables
- **Commit messages**: English, conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`, etc.). **Never include `Co-Authored-By:` trailers in commit messages.**
- **No EF Core, no CQRS** — the C# half is the sidecar core (handlers over a JSON protocol), so the template's CQRS/EF Core rules do not apply; `.ai/reference/critical-rules.md` items 1–6, 9–14, 18–24 are .NET-web guidance only
- **Async all the way**: Every async operation must be properly `await`ed — no fire-and-forget, no unhandled floating Promises. Use `@lit/task` (`Task` reactive controller) for async work in Lit lifecycle methods (`connectedCallback`, `updated`, `firstUpdated`) since they cannot be made `async`. Never write `this.someAsyncMethod()` without `await` or `void`; if `void` is the only option, it is a smell — prefer `@lit/task` instead.
- **Async method naming**: Every `async` method name must end with `Async` (e.g., `LoadProjectsAsync`, `getPackagesAsync`). This applies to all methods in all files — host, web, utilities, RPC, and components. Private methods included. Exception: Lit lifecycle overrides (`connectedCallback`, `disconnectedCallback`, `render`, etc.) which are spec-defined names.

## Security Rules

These apply to this project specifically:

| Area | Rule |
|------|------|
| Nonce generation | Use `globalThis.crypto.randomUUID()` — works in both Node.js 19+ and browser |
| Path validation | Use `src/NugetPackageManager.VSCode.Host/utilities/workspace-path.ts` (resolve + realpath + relative check) before passing any path to dotnet or a file write |
| URL validation | Validate source URLs with `new URL()` before passing to dotnet CLI |
| Script execution | Password scripts require a trusted workspace and a path under the machine-scoped `passwordScriptAllowlist`; only `.ps1`, `.bat`, `.cmd`, `.sh` are accepted |
| Sort/filter input | Validate against explicit allowlist before use |
| Event listeners | Store as class fields for proper cleanup; always remove in `disconnectedCallback` |

## Technology Stack

- **.NET sidecar**: .NET 10 (`net10.0`, `RollForward=LatestMajor`), published to `dist/core`; MSTest
- **UI Framework**: Lit 3.x (LitElement)
- **HTTP**: axios (NuGet API, proxy/auth support)
- **XML Parsing**: @xmldom/xmldom + xpath (.csproj/.sln files)
- **Layout**: Split.js (resizable panes)
- **Concurrency**: async-mutex (task serialization)
- **Telemetry**: OpenTelemetry (OTLP exporter, opt-in, no PII)
- **Build**: esbuild 0.25+ and `dotnet publish`
- **Lint**: ESLint 9 + typescript-eslint + prettier compat

## Task Execution Protocol

**On every non-trivial task (3+ steps or multi-file):**

1. Enter plan mode (`EnterPlanMode`), present the plan, wait for approval
2. Create a progress file in `.ai/progress/`, named after the task slug
3. Update progress file after each step (Edit `- [ ]` → `- [x]`)
4. On completion: mark DONE and move to `.ai/completed/`

**Do NOT use built-in `TaskCreate`/`TaskUpdate`/`TaskList` tools** — use local `.ai/progress/` markdown files instead.

## Session Management

1. Read `.ai/session-context.md` at session start
2. Update it before ending with current state and next steps
3. Plans are stored in `.ai/plans/` (configured via `plansDirectory` in `.claude/settings.json`)
