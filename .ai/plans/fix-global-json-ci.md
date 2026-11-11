# Pin .NET 10 in global.json and let CI install it

Status: IN PROGRESS
Started: 2026-11-11
Progress: `.ai/completed/fix-global-json-ci.md`

## Problem

`main` ships `global.json` with SDK `11.0.100` + `rollForward: disable` and a `tools.dotnet` pin.
CI provisions only .NET 10 (`setup-dotnet: 10.0.x`; `ci.yml` also installs 8.0.x), so every
`dotnet` step fails with "A compatible .NET SDK was not found".

The repository needs a pin (the build must be reproducible) — the pin just has to name an SDK the
workflows actually install.

## Change

`global.json`:

```json
{
  "sdk": {
    "version": "10.0.404",
    "rollForward": "latestFeature",
    "allowPrerelease": false
  }
}
```

- `10.0.404` is the current .NET 10 SDK patch and the one used locally/on the runner.
- `latestFeature` accepts a later 10.0.5xx SDK without jumping to .NET 11.
- Drop the `tools.dotnet: 11.0.100` block (it pins tool resolution to an SDK CI does not have).

Workflows (`ci.yml`, `quality-gate.yml`, `release.yml`): replace the hard-coded
`dotnet-version: 10.0.x` (and `8.0.x` in `ci.yml`) with

```yaml
      - name: Install .NET
        uses: actions/setup-dotnet@v4
        with:
          global-json-file: global.json
```

so `global.json` is the single source of truth for the SDK CI installs. Drop the stale 8.0.x
comment/runtime entry from `ci.yml` (nothing targets net8.0).

## Verification

1. `dotnet --version` from the repo root → `10.0.404`.
2. `npm run vscode:prepublish` succeeds.
3. `npm run quality` PASS.
4. Parse the three workflow YAML files (no syntax change beyond the step input).

## Out of scope

- Moving the pin to .NET 11 (the sidecar targets net10.0; `latestFeature` deliberately stays on 10).
