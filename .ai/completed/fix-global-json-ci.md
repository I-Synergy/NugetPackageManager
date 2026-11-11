# Pin .NET 10 in global.json and let CI install it

Status: IN PROGRESS
Started: 2026-11-11
Plan: `.ai/plans/fix-global-json-ci.md`

## Steps

- [x] global.json: SDK 10.0.404 + latestFeature; drop the tools pin
- [x] Workflows: install .NET from global.json (ci, quality-gate, release)
- [x] Verify: dotnet --version, vscode:prepublish, quality
- [x] Commit and force-push the PR branch

**Status:** DONE

## Result

- `global.json`: SDK `10.0.404`, `rollForward: latestFeature`, no `tools.dotnet` pin.
- `ci.yml`, `quality-gate.yml`, `release.yml` install .NET via
  `actions/setup-dotnet@v4` + `global-json-file: global.json`; the 8.0.x entry is gone.
- `dotnet --version` → 10.0.404; `npm run vscode:prepublish` and `npm run quality` (8/8) pass.

## Notes

- `setup-dotnet` reads `sdk.version` from the file, so CI installs exactly the pinned SDK.
- 8.0.x was only there for the removed net8.0 tests.
