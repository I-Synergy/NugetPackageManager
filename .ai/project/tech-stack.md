# Technology Stack

## Runtime & Language

- **Runtime**: Node.js v19+ (host), Browser (webview), .NET 8 (sidecar core, `net8.0` with `RollForward=LatestMajor`)
- **Languages**: TypeScript 5.x (`strict: true`) for the extension; C# (`LangVersion=latest`, nullable enabled, warnings as errors) for the core
- **Node.js requirement**: v19+ for `globalThis.crypto.randomUUID()`

## .NET Core Projects

| Project | Purpose |
|---|---|
| `src/NugetPackageManager.Core` | Sidecar entry point, JSON protocol, handlers |
| `src/NugetPackageManager.Core.NuGet` | NuGet source client, nuget.config resolution, advisories |
| `src/NugetPackageManager.Core.Workspace` | csproj model, CPM resolution/writer, target frameworks, dependency graph |

MSTest for all C# tests; the sidecar is published to `dist/core` by `npm run build:core`.

## Core Dependencies

| Category | Package | Version | Notes |
|----------|---------|---------|-------|
| **UI Framework** | `lit` | ^3.3.2 | LitElement web components |
| **HTTP Client** | `axios` | ^1.7.4 | Host-side HTTP (SDK install, local feed helpers) |
| **XML Parsing** | `@xmldom/xmldom` | ^0.8.15 | Host-side XML (`nuget.config`, local `.nupkg` metadata) |
| **XML Queries** | `xpath` | ^0.0.35 | XPath queries over host-side parsed XML |
| **Layout** | `split.js` | ^1.6.5 | Resizable panes in main 3-panel view |
| **Concurrency** | `async-mutex` | ^0.5.0 | Serialize dotnet task execution |
| **Telemetry** | `@opentelemetry/*` | various | Opt-in anonymous usage telemetry, OTLP |
| **Hashing** | `object-hash` | latest | Change detection for project lists |
| **Deep utils** | `lodash` | latest | Utility functions |

## Dev Dependencies

| Category | Package | Notes |
|----------|---------|-------|
| **Build** | `esbuild` ^0.27.4 | Dual bundle (host CJS + web ESM) |
| **TypeScript** | `typescript` ^5.3.3 | Compiler |
| **Linting** | `eslint` ^9.39.2 | Flat config (ESLint 9) |
| **Lint plugins** | `typescript-eslint`, `eslint-config-prettier` | TypeScript rules + prettier compat |
| **Testing** | `@vscode/test-cli` ^0.0.12 | Runs tests in VS Code extension host context |
| **Mocking** | `sinon` ^21.0.1 | Stubs, spies, sandboxes |
| **Packaging** | `@vscode/vsce` | Produces `.vsix` extension package |

## Frozen / Pinned Versions

- **ESLint**: Staying on 9.x — ESLint 10 has breaking config changes not yet migrated
- **OpenTelemetry**: Version-pinned to avoid peer dependency conflicts

## Technology Decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| IPC | typed RPC over `postMessage` | Only reliable cross-process channel in VS Code |
| NuGet domain | C# sidecar over stdio JSON-RPC | Reuses the NuGet SDK and MSBuild-aware project evaluation; keeps the Node host to plumbing |
| UI | Lit (LitElement) | Lightweight, no virtual DOM, native web components |
| HTTP | axios (not `fetch`) | Proxy/auth support needed for private NuGet feeds |
| XML | `@xmldom/xmldom` + `xpath` (host-side only) | `nuget.config` and local-feed work; project files are parsed in the core |
| Dotnet integration | `child_process.spawn` | Real-time stdout streaming for progress bars |
| Sidecar packaging | Framework-dependent IL, launched as `dotnet <dll>` | One universal VSIX for every OS/arch (the user also runs macOS). Measured 2026-11-01: ReadyToRun is 2.5x the size for 0 ms startup gain; trimming is 6.6x and needs source-generated JSON — both are per-RID. See `.ai/completed/sidecar-packaging-comparison.md`. |
| Testing | `@vscode/test-cli` + Mocha | Required to test VS Code API interactions |

## VS Code Extension Manifest

- **Extension ID**: `I-Synergy.nugetpackagemanager`
- **Activation**: On command or workspace with `.csproj`/`.sln` files
- **Webview**: Single persistent webview panel
- **Outputs**: `releases/*.vsix`
