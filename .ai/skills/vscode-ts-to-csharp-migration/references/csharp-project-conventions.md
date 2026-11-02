# Generated C# must follow the repository's layout, rules and guardrails

A port that compiles is not a port that belongs here. Every project the migration creates has to
fit the existing repository shape, or it will fail review, the quality gate, or both.

The rules below are extracted from this repository's actual enforcement points — not preferences.
When the skill's templates and a repository file disagree, the repository file wins:
`.editorconfig` > `Directory.Build.props` > this document > the skill templates.

## 1. Layout

```
<Repo>.slnx                         every project registered here (src + tests)
Directory.Build.props               compiler/analyzer policy for all C# projects
Directory.Packages.props            central package versions
.editorconfig                       naming and formatting, enforced in build

src/<Product>.Common/               shared constants, enums, wire primitives
src/<Product>.Core/                 sidecar exe: Program.cs + protocol + handlers
src/<Product>.Core.<Adapter>/       one project per third-party library boundary
src/<Product>.Core.<Domain>/        project model / domain logic
src/<Product>.VSCode.Common/        TS shared (host + webview)
src/<Product>.VSCode.Host/          TS extension host
src/<Product>.VSCode.Webview/       TS webview

tests/<Product>.Core.Tests/             MSTest — one test project per source project
tests/<Product>.Core.<Adapter>.Tests/
tests/<Product>.Core.<Domain>.Tests/
tests/<Product>.TestUtilities/          shared fixtures + path helpers (not a test project)
tests/<Product>.TestUtilities/Fixtures/ test data read at runtime by both suites
```

Rules:

- **One test project per source project**, named `<SourceProject>.Tests`, same folder grouping.
- A shared `TestUtilities` project holds fixture paths and temp-directory helpers; it is
  `IsPackable=false` and **not** a test project. Exclude `Fixtures/**` from compilation.
- Adapters get their own project so the domain logic can be tested without their dependencies.
- Every `.csproj` is registered in the `.slnx` so it appears in the solution and in IDE tooling. A
  project that is only reachable through `ProjectReference` still builds transitively, but it is
  invisible in the solution view and easy to miss in a review — register it.

## 2. Root build files — write them once, never per project

`Directory.Build.props` (root) carries the policy for every sidecar project:

```xml
<LangVersion>latest</LangVersion>
<Nullable>enable</Nullable>
<ImplicitUsings>enable</ImplicitUsings>
<TreatWarningsAsErrors>true</TreatWarningsAsErrors>
<EnforceCodeStyleInBuild>true</EnforceCodeStyleInBuild>
<AnalysisLevel>latest-recommended</AnalysisLevel>
<EnableNETAnalyzers>true</EnableNETAnalyzers>
<RollForward>LatestMajor</RollForward>
<Deterministic>true</Deterministic>
<GenerateDocumentationFile>true</GenerateDocumentationFile>
<NoWarn>$(NoWarn);CS1591</NoWarn>
```

Consequences for generated projects:

- **Do not repeat these in a `.csproj`.** A generated csproj that re-declares
  `TreatWarningsAsErrors` or `Nullable` hides drift when the root policy changes.
- `TreatWarningsAsErrors` + `EnforceCodeStyleInBuild` mean analyzer output is a build failure.
  Write the code clean the first time rather than adding suppressions.
- `GenerateDocumentationFile` exists so IDE0005 (unused usings) runs; CS1591 is disabled.
- **Fixtures must opt out.** The root files match `/Fixtures/` and set
  `IsSidecarProject=false`, which turns off `ManagePackageVersionsCentrally` and the strict
  settings. Preserve that mechanism when copying the templates into a new repository.

`Directory.Packages.props` (root) carries every version:

```xml
<ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
<PackageVersion Include="Microsoft.NET.Test.Sdk" Version="…" />
<PackageVersion Include="MSTest.TestAdapter" Version="…" />
<PackageVersion Include="MSTest.TestFramework" Version="…" />
<PackageVersion Include="Moq" Version="…" />
<PackageVersion Include="coverlet.collector" Version="…" />
```

`PackageReference` items carry **no `Version`** attribute. A version in a csproj bypasses central
management and is a review finding.

## 3. `.csproj` rules

| Project kind | Required | Forbidden |
|---|---|---|
| Sidecar exe (`Core`) | `OutputType=Exe`, `TargetFramework`, `RootNamespace`, `UseAppHost=false` (framework-dependent, launched as `dotnet App.dll`) | `PublishTrimmed`, `PublishReadyToRun` (measured: no gain, 2.5× size) |
| Library (`Common`, `Core.*`) | `TargetFramework`, `RootNamespace`; `PackageReference` without version; `InternalsVisibleTo` for test seams | duplicated analyzer/nullability settings |
| Test project | `TargetFramework`, `RootNamespace`, `IsPackable=false`, `IsTestProject=true`, MSTest + Moq + Test.Sdk + coverlet references, reference to the source project | xUnit, NUnit, any other test framework |

`InternalsVisibleTo` is how a domain type stays `internal` and still gets unit-tested:

```xml
<ItemGroup>
  <InternalsVisibleTo Include="<Product>.Core.<Domain>.Tests" />
</ItemGroup>
```

## 4. Code rules (compiler- and analyzer-enforced)

| Rule | Enforcement |
|---|---|
| One top-level type per file; subfolder per operation | review + audit script (interfaces may sit with their single implementation when the seam is trivial) |
| Async methods end with `Async` (including private) — **except** `[TestMethod]` methods, which follow `Method_Scenario_ExpectedResult` | analyzer + review; the test naming convention wins in `tests/` |
| Private/internal fields are `camelCase` (no underscore) — follow `.editorconfig`, not generic templates | IDE1006 |
| Public members PascalCase; interfaces `I{Type}`; enums plural except `*Status`; no `Dto` suffix (name the concept: `XResponse`, `CreateXRequest`) | review + audit script |
| `sealed` on concrete classes that are not designed for inheritance | analyzer |
| File-scoped namespaces (`namespace X;`) | `.editorconfig` |
| `ArgumentNullException.ThrowIfNull(x)` for public parameters | analyzer |
| `StringComparer.Ordinal` / `StringComparison.Ordinal` for identifiers | review |
| `ConfigureAwait(false)` in library code | review |
| Records with `required`/`init` for wire DTOs | review |
| Exhaustive `switch` on enums fights CS8524 vs IDE0072 — use `if` chains | compiler |
| No `#pragma warning disable` without a `Justification`; the only precedent is CA1031 at the protocol boundary | review |
| `internal` rather than `public` for anything not needed across assemblies | review |

Comments explain **why**, not what. A generated file full of narration is a review finding.

## 5. Test rules (MSTest only)

```csharp
// File: tests/<Product>.Core.Tests/<Area>/<Type>Tests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// One or two lines: what this suite pins and where the TypeScript twin used to live.

using <Product>.Core.<Area>;

namespace <Product>.Core.Tests.<Area>;

[TestClass]
public sealed class <Type>Tests
{
    [TestMethod]
    [TestCategory("Unit")]
    public async Task Method_Scenario_ExpectedResult()
    {
        // Arrange
        // Act
        // Assert
    }
}
```

- `// File:` header is **required**; `// Traces:` is required when the slice carries acceptance
  criteria (otherwise `none — legacy mode …`).
- `[TestClass]` + `[TestMethod]` + `[TestCategory("Unit")]`.
- Method name: `Method_Scenario_ExpectedResult` — underscores, no `Async` suffix.
- Fixtures come from `TestUtilities` (`TestPaths.Fixture(...)`), never `Directory.GetCurrentDirectory()`
  — the test host's working directory is the VS Code install directory.
- Mock with Moq; assert with `Assert.*`; no FluentAssertions, no xUnit-style `[Fact]`.
- Integration/E2E tests are opt-in and labelled separately; they are not in the unit run.

## 6. Forbidden packages

xUnit, NUnit, MediatR, SpecFlow, Swashbuckle, Serilog, FluentValidation, standalone Polly. Use the
repository's alternatives (MSTest, Reqnroll, built-in logging/validation/resilience). If a port
needs a package not already in `Directory.Packages.props`, add the version there and justify it in
the PR; do not inline a version.

## 7. Guardrail audit

```bash
node .ai/skills/vscode-ts-to-csharp-migration/scripts/audit-csharp-projects.mjs <repo-root>
```

Checks, without building:

- root `Directory.Build.props` / `Directory.Packages.props` present with the policy above
- every `src/*.csproj` registered in the `.slnx` and paired with `tests/<Name>.Tests`
- no `Version=` on `PackageReference`; no xUnit/NUnit; exe has `UseAppHost=false`
- public async methods in `src/` end with `Async`
- no type name ending in `Dto`
- test files carry `// File:` and `[TestCategory(...)]`
- one top-level type per file (warning; interfaces with their sole implementation are tolerated)

Run it before the first build and in the wave gate. A generated project that fails this audit will
fail review.

## 8. What "done" means for a generated project

- `dotnet build <Repo>.slnx -c Release` clean under warnings-as-errors
- `dotnet test <Repo>.slnx -c Release` green, MSTest only
- the audit script reports no failures
- the project is in the `.slnx`, has a `.Tests` twin, and every package version lives in
  `Directory.Packages.props`
