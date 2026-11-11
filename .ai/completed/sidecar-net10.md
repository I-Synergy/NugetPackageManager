# Sidecar on .NET 10 LTS

Status: IN PROGRESS
Started: 2026-11-11
Plan: `.ai/plans/sidecar-net10.md`

## Steps

- [x] Retarget the four sidecar projects to `net10.0`
- [x] Retarget the four test/utility projects to `net10.0`
- [x] Upgrade NuGet.* to 8.0.0 and fix any API fallout
- [x] Update `Directory.Build.props` comment and the workflow .NET setup
- [x] Build + run both C# test suites; publish the sidecar and verify runtimeconfig/ping
- [x] Docs: README, AGENTS.md, CLAUDE.md, `.ai/project/*`, CHANGELOG
- [x] Full `npm run quality` and diff review

**Status:** DONE

## Result

- Sidecar and tests target `net10.0`; NuGet client libraries are `8.0.0`.
- Extra net10 analyzer fallout fixed: `System.Threading.Lock` in five cache classes and one test
  helper, `JsonElement.Parse` in two test helpers, `IPackageSearchMetadata.Title` non-nullable.
- `Directory.Packages.props` pins `System.Security.Cryptography.Pkcs` 8.0.2 to lift the
  vulnerable 8.0.1 NuGet.Protocol 8.0.0 brings in (NuGet audit, treated as an error).
- Published sidecar: framework-dependent `net10.0`, `rollForward: LatestMajor`,
  `Microsoft.NETCore.App 10.0.0`; `dist/core` is 4.9 MB / 23 files and answers `ping`.
- `npm run quality` PASS 8/8 (C# build + tests, TS tests, lint, typecheck, audit).

## Notes

- Keep the universal framework-dependent packaging; no self-contained bundle.
- `RollForward=LatestMajor` keeps the net10 build runnable on the .NET 11 runtime.
