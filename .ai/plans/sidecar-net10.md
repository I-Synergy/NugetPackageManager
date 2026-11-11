# Sidecar on .NET 10 LTS

Status: APPROVED (2026-11-11)
Started: 2026-11-11
Progress: `.ai/progress/sidecar-net10.md`

## Decision

Keep the universal, framework-dependent sidecar (see
`.ai/completed/sidecar-packaging-comparison.md`) and move its target from `net8.0` to
`net10.0` (LTS). `RollForward=LatestMajor` still lets the same IL run on the .NET 11 runtime.
No self-contained bundle, no per-platform VSIXs.

This unlocks NuGet 8.0.0, whose assets target `net10.0` + `net472` (verified). NuGet 7.9.0
only offers `net8.0`, which is why the repo could not take 8.0.0 before.

Reasons against bundling (unchanged): ~80 MB per RID measured for a single-file
self-contained build; per-platform VSIXs; the extension still shells out to the `dotnet`
SDK for restore/install/update/TFM work, so bundling the runtime does not remove the SDK
prerequisite.

## Changes

### Target frameworks

- `src/NugetPackageManager.Common`, `.Core`, `.Core.NuGet`, `.Core.Workspace`: `net8.0` → `net10.0`.
- Test projects `tests/NugetPackageManager.Core.Tests`, `.Core.NuGet.Tests`,
  `.Core.Workspace.Tests`, `tests/NugetPackageManager.TestUtilities`: `net8.0` → `net10.0`.
  A test project cannot reference a higher TFM, and `TestUtilities` is referenced by the tests.
- Fixture projects under `tests/NugetPackageManager.TestUtilities/Fixtures/` are evaluated
  inputs, not built projects — leave them (they already target multiple TFMs).

### Dependencies

- `Directory.Packages.props`: `NuGet.Frameworks`, `NuGet.Protocol`, `NuGet.Versioning`
  `7.9.0` → `8.0.0` (the point of the move). If 8.0.0 needs non-trivial code changes,
  report instead of forcing it.

### Build metadata and CI

- `Directory.Build.props`: update the `RollForward` comment to name `net10.0` and the
  .NET 11 runtime; keep `RollForward=LatestMajor`.
- `.github/workflows/quality-gate.yml` and `release.yml`: the `setup-dotnet` steps and their
  comments say `8.0.x` provides the test runtime. Drop `8.0.x`; keep `10.0.x`.
- Do not add or commit `global.json` (the user has an untracked local pin on SDK 11).

### Docs

- `README.md` requirements: `.NET SDK 8+` → `.NET SDK 10+` (LTS; the same build runs on 11).
- `AGENTS.md`, `CLAUDE.md`: the sidecar target/requirements lines.
- `.ai/project/tech-stack.md`, `.ai/project/architecture.md`: `net8.0` → `net10.0`.
- `CHANGELOG.md` (Unreleased): `chore:` entry describing the new minimum and the NuGet 8.0 bump.

## Verification

1. `dotnet build NugetPackageManager.slnx -c Release`.
2. `dotnet test NugetPackageManager.slnx -c Release`.
3. `npm run build:core`; confirm `dist/core/NugetPackageManager.Core.runtimeconfig.json`
   requests `Microsoft.NETCore.App` 10.0.0 and the sidecar answers `ping`.
4. `npm run quality` (bundles, lint, typecheck, C# build + tests, TS tests, audit).
5. Package a local dated VSIX only if asked.

## Out of scope

- Self-contained or per-platform VSIX packaging.
- Changing the VS Code host / webview TypeScript.
- Fixing the Installed-arrow inconsistency and the scan's silent latest-lookup failure — a
  separate follow-up.
