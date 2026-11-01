# C# Coverage to 100% (coverlet)

Status: AWAITING DECISION
Date: 2026-11-01

## Delivered already (verified)

- `tests/coverlet.runsettings` — cobertura + opencover, `IncludeTestAssembly=false`,
  generated sources (`**/obj/**/*.cs`) and `[GeneratedCode]`/`[CompilerGenerated]`/
  `[ExcludeFromCodeCoverage]` members excluded.
- `npm run test:csharp` — writes `coverage/csharp/**/coverage.cobertura.xml` and
  `coverage.opencover.xml` (the two formats the SonarCloud .NET scanner imports).
- `npm run quality` now always collects the C# report (same path), next to the existing
  TypeScript `coverage/lcov.info`.

## Baseline (generated regex sources excluded)

| Metric | Now |
|---|---|
| Line | 2375/2740 = **86.7%** |
| Branch | 387/619 = **62.5%** |
| Files under 100% | 30 |

Worst offenders: `ToolchainHandlers` 0/59, `DiagnosticHandlers` 0/21,
`NuGetSourceProvider` 0/21, `SourceRepositoryFactory` 0/10, `TargetFrameworkResolver` 30/95,
`ToolchainAnalysis` 29/245, `HttpNuGetSource` 24/53, `GlobalJson` 23/268,
`DotnetFailureClassifier` 20/149, `CpmCondition` 19/269, `AssetsGraph` 17/139.

Rules to respect while writing them: MSTest only (xUnit/NUnit are forbidden here), central
package versions, and **duplication ≤ 3% on new code** — so the new tests use `[DataRow]`
tables and shared builders instead of copy-paste blocks.

## Blocker on the Sonar side (needs a decision)

The SonarCloud docs for test coverage state: importing coverage "is only available for
CI-based analysis. **It is not available for automatic analysis.**" This project currently uses
automatic analysis (`.sonarcloud.properties` says so, and no workflow runs a scanner).

So the reports will be produced and uploaded either way, but SonarCloud will only *show* C#
coverage after the project moves to CI-based analysis: a `sonar-scanner`/SonarSource action step
with `SONAR_TOKEN`, plus switching the project off automatic analysis in SonarCloud.

## Open decisions

1. Target: 100% **line** only, or 100% line **and branch** (branch is the expensive half:
   62.5% → 100% means every boolean path, including defensive ones).
2. Sonar wiring: move to CI-based analysis now, or keep producing reports only.
3. Whether genuinely unreachable code (`Program.cs` top-level entry point, argument guards that
   cannot fail given the callers, `catch` blocks for framework exceptions) may carry
   `[ExcludeFromCodeCoverage]` with a comment, or must be exercised.
