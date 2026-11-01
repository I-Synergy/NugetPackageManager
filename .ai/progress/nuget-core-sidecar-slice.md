# NuGet core sidecar — first slice

Status: IN PROGRESS
Started: 2026-11-01
Plan: `.ai/plans/nuget-core-sidecar-slice.md`

## Restructure (2026-11-01)

Repository layout now follows `.ai/skills/solution-generator/SKILL.md`:

- `NugetPackageManager.slnx` at the root.
- `src/NugetPackageManager.Core/` — C# exe (NDJSON transport), namespace `NugetPackageManager.Core`.
- `src/NugetPackageManager.Core.NuGet/` — C# adapter (`NuGet.Protocol`), namespace `NugetPackageManager.Core.NuGet`.
- `src/NugetPackageManager.Core.Workspace/` — C# project model (CPM conditions, project files),
  namespace `NugetPackageManager.Core.Workspace`.
- `src/NugetPackageManager.VSCode.Common|Host|Webview/` — TypeScript projects, each with its own
  `tsconfig.json` extending `tsconfig.base.json` (which owns the `@/common`, `@/host`, `@/web` aliases).
- `tests/NugetPackageManager.Core.Tests/`, `tests/NugetPackageManager.Core.NuGet.Tests/`,
  `tests/NugetPackageManager.Core.Workspace.Tests/` — **MSTest** (xUnit/NUnit are forbidden by
  `.ai/reference/forbidden-tech.md`), `[TestClass]`/`[TestMethod]`/`[TestCategory("Unit")]`,
  `Method_Scenario_ExpectedResult` naming, `// File:` header. Each C# project has a test project
  named after it.
- `tests/NugetPackageManager.VSCode.Tests/` — the 50 Mocha/Sinon test files, imports rewritten to
  the `@/` aliases; `test-paths.ts` resolves the repository root by walking up (never `process.cwd()`,
  which is the VS Code install directory inside the extension host).
- Central package management **is** used: `Directory.Packages.props` at the root drives every C#
  project. It is discovered by every project below the root, so the `__fixtures__` trees opt out
  twice — `Directory.Build.props` and `Directory.Packages.props` both skip paths containing
  `__fixtures__`, and `tests/__fixtures__/Directory.Packages.props` sets
  `ManagePackageVersionsCentrally=false` so test data never inherits the repository's versions.
- The MSBuild fixtures live under `tests/__fixtures__/` (they are test data used by both suites,
  not source), and `tests/__fixtures__/Directory.Packages.props` isolates them.

## Steps

- [x] Introduce the interface (TS only) — `INuGetSourceApi` in
      `src/NugetPackageManager.VSCode.Common/rpc/...` companion module; `NuGetApi` and the factory
      type against it. No call-site changes.
- [x] Sidecar skeleton (C# + build) — NDJSON server with handshake, `ping`, `cancel`, structured
      errors. `dotnet build NugetPackageManager.slnx` clean under warnings-as-errors; `dotnet test`
      7/7 MSTest; `npm run build:core` publishes 3.7 MB to `dist/core`.
- [x] Sidecar client (TS) — `src/NugetPackageManager.VSCode.Host/nuget/core-client.ts` (`CoreClient`):
      lazy start, handshake timeout, id matching, per-request deadline, AbortSignal → `cancel`,
      crash detection with bounded restart, stderr forwarding, `Dispose`. 7 fake-sidecar tests.
- [x] `SidecarNuGetApi` adapter mapping the four methods onto the wire contract
      — `sidecar-source-api.ts` (`SidecarSourceApi`) + `core-process.ts` (process ownership,
      configured at activation, disposed at deactivation). Folder-based sources still delegate to
      `local-feed.ts`, which has no C# counterpart yet. `nuget/api.ts` and `api.test.ts` are
      **deleted**: the C# core is now the only NuGet source implementation.
- [x] Implement the four methods in C#
      — all four ported: `getVulnerabilities` (`IVulnerabilityInfoResource`), and
      `getPackages` / `getPackage` / `getPackageDetails` as a faithful port of the
      registration/search JSON reading, which preserves the leaf URLs and `Verified` that
      `NuGet.Protocol` does not expose. 33 MSTest cases; verified live against nuget.org.
      Wave B of `.ai/plans/ts-to-csharp-migration.md` is done in C#; the TypeScript twin and
      the adapter wiring follow in the next step.
- [ ] Parity harness
- [ ] Wire behind `nugetpackagemanager.useCore`
- [ ] Gate, packaging, docs

## Notes

- Branch: `spike/blazor-wasm-webview`
- Verification after the restructure: `dotnet build`/`dotnet test` green, `tsc` (src + tests) clean,
  `eslint src tests` clean, `esbuild` clean, `npm test` 535 passing (matches the 535 statically
  declared tests; the earlier 541 counted duplicate copies left behind in a stale `out/`).
