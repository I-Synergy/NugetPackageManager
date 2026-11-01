# Wave E — diagnostics through the .NET core

Status: DONE
Started: 2026-11-01
Completed: 2026-11-01

## Steps

- [x] Port `restore-diagnostics.ts` to `Core/Diagnostics/RestoreOutput.cs` (NU1107/NU1605/
      NU1109/NU1608/NU1102, chains, dedupe, format, summary)
- [x] Port `dotnet-failure.ts` classification to `Core/Diagnostics/DotnetFailureClassifier.cs`
      (SDK/workload/pinned-SDK, audit, restore, feed/credential, unknown)
- [x] Add the `classifyDotnetFailure` handler (`DiagnosticHandlers`) and register it
- [x] Turn `utilities/dotnet-failure.ts` into the thin `ClassifyDotnetFailureAsync` adapter
- [x] Restructure `TaskExecutor` to settle the process first and await classification after
- [x] Switch `toolchain-health.ts` and the host's restore attribution/failure paths to the
      wire failure; delete `ToFailureInfo`, `ParseRestoreConflicts`, `SummarizeRestoreFailure`,
      `FormatRestoreConflicts`
- [x] Delete `restore-diagnostics.ts` and the TS suites for both modules
- [x] Add C# tests: `RestoreOutputTests` (10) and `DotnetFailureClassifierTests` (6)
- [x] Verify: `dotnet test` 150/150, `npm test` 395 passing (clean `out`), typecheck, lint,
      esbuild, `git diff --check`

## Notes

- `dotnet-context.ts` stays in TypeScript: it resolves the spawn working directory and the
  `dotnet` host synchronously before every invocation and depends on the private-install lookup
  (Wave F). The classifier receives `PinnedSdkVersion` and `GlobalJsonPath` from the host.
- Classification is best-effort: if the core cannot answer, `ClassifyDotnetFailureAsync` returns
  an `Unknown` failure instead of replacing the real error.
- Host-side restore attribution now reads `Conflicts[].Chains` from the wire shape; the rich
  constraint ranges stay in the core.
- A stale `out/` directory made an intermediate full run include deleted tests; the final
  verification used a clean compile. `npm test` is 395 passing with zero failures.
