# GitHub Copilot Instructions

## Project Context

**NuGet Package Manager** is a Visual Studio Code extension for browsing, installing, updating and
auditing NuGet packages across .NET projects. It is a **dual-language repository**:

- **.NET / C# core** — `src/NugetPackageManager.Core`, `.Core.NuGet` and `.Core.Workspace`
  (`NugetPackageManager.slnx`), published to `dist/core` and run as a sidecar process. It owns the
  NuGet source client, the project model, CPM resolution, dependency operations and toolchain
  detection.
- **TypeScript / Node.js extension** — `src/NugetPackageManager.VSCode.Common`, `.VSCode.Host` and
  `.VSCode.Webview`. It owns VS Code activation, the typed RPC layer and the Lit webview.

Neither half is legacy: a change to the sidecar contract crosses C#, `HostAPI` and the webview.

See `AGENTS.md` for the canonical agent guide and `.ai/project/` for architecture, technology and
preferences. `CLAUDE.md` retains the detailed engineering guide.

## Session Memory

`.ai/session-context.md` is the shared memory for every client. Read it first:

1. **Start:** read `.ai/session-context.md` and `.ai/completed/`
2. **Work:** track progress in `.ai/progress/`, delegate code work to subagents
3. **End:** write a handoff to `.ai/session-context.md` using
   `.ai/reference/templates/session-handoff.md.txt`, set `Written By` to the client name,
   update sections in place, and never overwrite another client's entries. Move finished
   progress files to `.ai/completed/`.

In this template repository the file stays the unfilled placeholder; in this project it is
populated with real session state.

## Architecture

Three runtime contexts, two of them in the extension process:

```
VS Code Extension Host (Node.js)         Webview (Browser / Lit components)
  src/NugetPackageManager.VSCode.Host/extension.ts
  src/NugetPackageManager.VSCode.Host/host-api.ts  <-- RPC -->  src/NugetPackageManager.VSCode.Webview/main.ts
  src/NugetPackageManager.VSCode.Common/rpc/rpc-host.ts         src/NugetPackageManager.VSCode.Common/rpc/rpc-client.ts
        │
        │ sidecar JSON-RPC over stdio (nuget/core-process.ts, nuget/core-client.ts)
        ▼
.NET core (dist/core) — src/NugetPackageManager.Core* projects
```

All host ↔ webview communication goes through a typed RPC layer defined in
`src/NugetPackageManager.VSCode.Common/rpc/types.ts`. Every RPC method returns `Result<T>` — a
discriminated union `{ ok: true, value: T } | { ok: false, error: string }`.

## Key Rules

### TypeScript
- `strict: true` — no `any` unless unavoidable
- Prefix unused variables with `_`
- Every `async` method name ends with `Async`
- Aliases: `@/common/*`, `@/host/*`, `@/web/*` → the three `src/NugetPackageManager.VSCode.*` projects
- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`

### C#
- `net8.0`, nullable enabled, warnings are errors, analyzers on (`Directory.Build.props`)
- The sidecar is published framework-dependent with `RollForward=LatestMajor`
- Core failures cross the sidecar boundary as structured errors, never as unhandled exceptions
- MSTest for tests; a contract change needs a core test and a host test

### RPC Methods (host-api.ts)
- Always return `Result<T>` using `ok(value)` / `fail(message)` helpers
- Validate all inputs at the RPC boundary (workspace paths, URLs, sort options)
- Never pass user-controlled strings directly to `child_process.spawn` args without validation

### Web Components (Lit)
- Use `@state()` for reactive internal state, `@property()` for external inputs
- Store event listeners as class fields; always clean up in `disconnectedCallback`
- Use `await element.updateComplete` in tests, not manual DOM ticks
- No raw `innerHTML` — use Lit `html` template literals (XSS-safe)

### Security
- Nonces: `globalThis.crypto.randomUUID().replace(/-/g, "")` — works in Node.js 19+ and browser
- Project paths must be validated inside a workspace folder before passing to dotnet
- Source URLs must be validated with `new URL()` before passing to dotnet
- Password script extensions are restricted to `.ps1`, `.bat`, `.cmd`, `.sh`

### Progress Tracking
- `child_process.spawn` is used (not `vscode.Task`) so stdout can be parsed for progress stages
- `TaskExecutor.ExecuteCommandAsync` stores progress in a `Map<string, OperationProgress>` keyed by `operationId`
- Long mutations run as host-side jobs (`utilities/operation-jobs.ts`); the webview polls and can cancel

## Build Commands

```bash
npm run esbuild          # host + web bundles
npm run build:core       # dotnet publish the C# sidecar to dist/core
npm run lint             # ESLint 9
npm run typecheck        # tsc over src and the TS test project
npm test                 # VS Code Test CLI + Mocha (TypeScript)
dotnet test NugetPackageManager.slnx -c Release   # MSTest
npm run quality          # full gate: bundles, lint, typecheck, C# build + tests, TS tests, audit
npm run package          # produce .vsix
```

## File Conventions

| Path pattern | Purpose |
|---|---|
| `src/NugetPackageManager.VSCode.Host/*.ts` | Extension host (Node.js) — VS Code API, activation, RPC dispatch |
| `src/NugetPackageManager.VSCode.Host/nuget/*.ts` | Core bridge (`core-process`, `core-client`) and source adapters |
| `src/NugetPackageManager.VSCode.Host/utilities/*.ts` | Host utilities (CPM adapters, task executor, decorators, SDK) |
| `src/NugetPackageManager.VSCode.Webview/components/*.ts` | Lit web components (browser) |
| `src/NugetPackageManager.VSCode.Common/rpc/` | Shared RPC types, host, client |
| `src/NugetPackageManager.Core*/**/*.cs` | .NET sidecar: handlers, NuGet source client, workspace model |
| `tests/NugetPackageManager.VSCode.Tests/**/*.test.ts` | TypeScript tests (Mocha + Sinon) |
| `tests/NugetPackageManager.Core*.Tests/**/*.cs` | C# tests (MSTest) |
