# Framework-compatible update candidates

Status: IN PROGRESS
Started: 2026-11-10
Plan: `.ai/plans/framework-compatible-updates.md`

## Steps

- [x] Core: model + `PackageFrameworkCompatibility` helper + `INuGetSource`/`ProtocolNuGetSource` method
- [x] Core: `getPackageVersionCompatibility` handler + cache invalidation
- [x] Core tests: compatibility helper, source, handler; `dotnet build` + `dotnet test`
- [x] Host: source API method + adapter
- [x] Host: scan compatibility gate with per-run cache
- [x] Host: Installed-tab arrow compatibility gate
- [x] Host tests (new regression + existing stubs); typecheck + lint
- [x] Docs: CHANGELOG + README
- [x] Full verification (`npm run quality`) and diff review

**Status:** DONE

## Result

- `npm run quality` PASS 8/8 (bundles, lint, typecheck, C# build, C# tests, TS tests, audit).
- C#: `Core.NuGet.Tests` 67 passed, `Core.Tests` 110 passed.
- TS: 546 passing (includes the `net10.0` row / `12.0.0` regression and the arrow fallback).

## Notes

- The safety gate is fail-open: unknown framework data never hides an update.
- Only cross-major candidates are checked, so ordinary patch scans keep their cost.
