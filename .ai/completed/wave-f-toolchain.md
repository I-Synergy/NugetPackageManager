# Wave F — toolchain through the .NET core

Status: DONE
Started: 2026-11-01
Completed: 2026-11-01

## Steps

- [x] Port the `global.json` edit path to `Core/Toolchain/GlobalJson.cs` (comment/BOM-tolerant
      parse, validation, feature band, coherence plan, surgical edit, canonical fallback)
- [x] Port toolchain detection to `Core/Toolchain/ToolchainAnalysis.cs` (`--list-sdks`, pin
      satisfaction, MSBuild property, `sdk check` tables, orphaned manifest bands, health)
- [x] Add handlers `updateGlobalJsonSdkVersion` and `evaluateToolchain` (`ToolchainHandlers`)
- [x] Rewrite `global-json.ts`, `toolchain-health.ts` and `sdk-check.ts` as host adapters
      (template creation, spawning, cache, clipboard report)
- [x] Remove the ported parsing helpers from `sdk-locations.ts` and the TS tests
- [x] Add C# tests: `GlobalJsonTests` (10), `ToolchainAnalysisTests` (13)
- [x] Verify: `dotnet test` 172/172, `npm test` 374 passing, typecheck, lint, esbuild,
      `git diff --check`

## Notes

- `sdk-install.ts`, `workload-commands.ts`, `sdk-locations.ts` and `dotnet-context.ts` stay in
  TypeScript: they are the spawn/path plumbing the plan says the host keeps (trust boundary,
  synchronous command selection before spawning).
- `RedactDiagnostics` stays with the report formatter in `toolchain-health.ts`; the core does not
  build presentation text.
- The core derives orphaned manifest bands from the system SDK path in the captured
  `--list-sdks` output, so the host passes no dotnet-root setting.
- `installSdkAsync` now awaits the core-backed pin; the SDK install itself is unchanged.
- All migration waves (A–F) are complete; what remains in TypeScript is host plumbing and the
  thin adapters listed in `.ai/session-context.md`.
