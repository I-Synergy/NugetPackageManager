# NuGet Config Resolver Slice

Status: DONE
Started: 2026-11-01
Finished: 2026-11-01
Plan: `.ai/plans/nuget-config-resolver-slice.md`

## Steps
- [x] Step 1: C# config models + parser
- [x] Step 2: C# discovery + merger
- [x] Step 3: sidecar handler + registration
- [x] Step 4: MSTest coverage
- [x] Step 5: TS adapter + resolver refactor
- [x] Step 6: TS test migration
- [x] Step 7: verify (dotnet build/test, typecheck, lint, npm test)
- [x] Step 8: docs

## What moved

C# (`src/NugetPackageManager.Core.NuGet/Configuration/`):

- `NuGetConfigModels.cs` — sources, credentials, file result, location, failure, resolution, environment.
- `NuGetConfigParser.cs` — `<packageSources>`, `<clear/>`, `<disabledPackageSources>`,
  `<packageSourceCredentials>` (with `_xHHHH_` decoding), `<packageSourceMapping>`; environment
  expansion is a per-file flag.
- `NuGetConfigDiscovery.cs` — machine → user → workspace order; the file-system probe is injectable.
- `NuGetConfigResolver.cs` — merge with the previous precedence and `<clear/>` semantics.
- `src/NugetPackageManager.Core/ConfigurationHandlers.cs` — `resolveNuGetConfig` handler.

TypeScript:

- New `nuget/config-client.ts` maps the wire shape to `SourceWithCredentials`.
- `utilities/nuget-config-resolver.ts` keeps only the VS Code half: settings sources, trust gate,
  allowlist + realpath check, password-script execution, local-feed classification, logging.

## Verification

- `dotnet build NugetPackageManager.slnx -c Release` — succeeded.
- `dotnet test NugetPackageManager.slnx -c Release --no-build` — 201/201
  (Core.NuGet 39, Core.Workspace 89, Core 73).
- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — 358 passing, exit 0. (374 → 358: the four parsing/discovery suites moved to MSTest,
  which gained 29 cases.)
- `validate-agents-md.py`, `validate-prose.py`, `git diff --check` — clean.

## Security invariants now pinned by tests

- `%VAR%` expands for machine/user configs and never for a workspace config
  (`Parse_Credentials_NeverExpandForAWorkspaceFile`, `Resolve_DiscoversAndMergesRealFiles_…`).
- A workspace `<clear/>` sets `ClearFound`; a user-level one does not
  (`Merge_WorkspaceClearResetsSourcesAndSetsTheFlag`, `Merge_UserLevelClearDoesNotSetTheFlag`).
- Password scripts still require trust + allowlist + realpath containment in TypeScript before spawn.
