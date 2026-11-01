# C# Coverage to 100%
Status: IN PROGRESS — 91.4% line / 65.5% branch
Started: 2026-11-01

Plan: `.ai/plans/csharp-coverage-100.md`
Target: **100% line** on `src/**` (decided); documented `[ExcludeFromCodeCoverage]` allowed;
SonarCloud stays on automatic analysis, so the reports are produced/uploaded but not imported.

## Steps
- [x] coverlet tooling: `tests/coverlet.runsettings`, `npm run test:csharp`, gate wiring
- [x] Baseline measured: 86.7% line / 62.5% branch (generated regex sources excluded)
- [x] `ToolchainHandlers` — 0/59 → 100% (`ToolchainHandlersTests`)
- [x] `DiagnosticHandlers` — 0/21 → 100% (`DiagnosticHandlersTests`)
- [x] Exception types (`RpcException`, `WorkspaceException`, `NuGetSourceException`) — 100%
      (`ExceptionTypesTests`)
- [x] `TargetFrameworkResolver` — 30/95 → **4/110** (`TargetFrameworkResolverFallbackTests`, 12 tests)
- [ ] Remaining 25 files, ~236 lines (see backlog)
- [ ] Mark genuinely unreachable code with `[ExcludeFromCodeCoverage]` + comment
- [ ] Final run to confirm 100% line, then `npm run quality`

## Backlog (missed lines / total)

| File | Missed |
|---|---|
| `Core.Workspace/TargetFrameworks/TargetFrameworkResolver.cs` | 4/110 |
| `Core/Toolchain/ToolchainAnalysis.cs` | 24/245 |
| `Core.NuGet/Sources/HttpNuGetSource.cs` | 24/53 |
| `Core/Toolchain/GlobalJson.cs` | 23/268 |
| `Core.NuGet/Sources/NuGetSourceProvider.cs` | 21/21 (0%) |
| `Core/Diagnostics/DotnetFailureClassifier.cs` | 20/149 |
| `Core.Workspace/Cpm/CpmCondition.cs` | 19/269 |
| `Core.Workspace/Dependencies/AssetsGraph.cs` | 17/139 |
| `Core.Workspace/Cpm/CpmWriter.cs` | 15/203 |
| `Core.NuGet/Sources/SourceRepositoryFactory.cs` | 10/10 (0%) |
| `Core/DependencyHandlers.cs` | 9/123 |
| `Core.NuGet/Sources/NuGetHttpClient.cs` | 9/15 |
| `Core.NuGet/Sources/PackageMapping.cs` | 7/171 |
| `Core.Workspace/WorkspaceModelService.cs` | 6/52 |
| `Core.NuGet/Vulnerabilities/NuGetVulnerabilityReader.cs` | 6/6 (0%) |
| `Core/Diagnostics/RestoreOutput.cs` | 5/89 |
| `Core/Protocol/NdjsonServer.cs` | 4/49 |
| `Core.Workspace/Dependencies/VersionSemantics.cs` | 3/21 |
| `Core.Workspace/Cpm/CpmPropsReader.cs` | 2/146 |
| `Core/WorkspaceHandlers.cs` | 2/56 |
| `Core.NuGet/Configuration/NuGetConfigResolver.cs` | 1/65 |
| `Core/NuGetCoreHandlers.cs` | 1/47 |
| `Core/ConfigurationHandlers.cs` | 1/44 |
| `Core.Workspace/Dependencies/RequirementClosure.cs` | 1/38 |
| `Core/Program.cs` | 16/16 (entry point — candidate for exclusion) |

## Defect found while writing the resolver tests

`dotnet msbuild -getProperty` changed output format: .NET 9+ prints **JSON**
(`{"Properties":{"TargetFrameworks":"..."}}`), older SDKs print `Property = value` lines.
`TargetFrameworkResolver.ParseFrameworks` only understood the line form, so on this machine
(SDK 11) the msbuild evaluation silently returned zero frameworks and the resolver fell back to
the literal XML parse — which cannot see conditional `TargetFramework` declarations.

Fixed: `ParseFrameworks` now dispatches on the leading `{` and reads either shape; the new
`EvaluateWithMsBuildAsync_ReturnsTheDeclaredFrameworks` test pins the JSON path.

## Gate wiring fix

The first version of the C# coverage step passed `--collect:XPlat Code Coverage` through the
gate's `run()`, which uses `shell: true` on Windows (needed for the npm `.cmd` shims). cmd.exe
split the argument at the space, and MSBuild saw `Code Coverage` as extra project arguments
(`MSB1008`). `run()` now takes `{ shell }` and the two dotnet steps pass `shell: false`; the
step loop forwards that option. Gate is back to 8/8.

## Notes

- Tests added so far: `ToolchainHandlersTests` (6), `DiagnosticHandlersTests` (3),
  `ExceptionTypesTests` (3). C# suite is 216 tests (85 + 42 + 89), all passing.
- Coverage re-measure: `npm run test:csharp`, then
  `python <scratch>/cov_report.py coverage "csharp/**/coverage.cobertura.xml"`.
- Keep tests parameterised (`[DataRow]`) — SonarCloud caps duplicated lines on new code at 3%
  and the current estimate is 0.2%.
