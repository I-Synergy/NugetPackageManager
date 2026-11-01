# Plan: C# test utility layer + fixtures relocation

Status: APPROVED (user: "create a c# text utility layer and place there also the fixtures in it")

## Decision

Create a new non-test C# project `tests/NugetPackageManager.TestUtilities` that owns:

- `TestPaths` — repository-root discovery (one copy instead of four), `FixturesRoot`,
  `Fixture(params string[])`, `ReadFixture(params string[])`.
- `TemporaryDirectory` — `IDisposable` temp workspace with recursive cleanup.
- `__fixtures__/` — the 22 tracked fixture files moved from `tests/__fixtures__`.

The folder keeps the `__fixtures__` name on purpose: `Directory.Build.props` and
`Directory.Packages.props` opt those `.csproj` files out via `Contains('__fixtures__')`, and the
TypeScript build/test excludes key off the same name. Renaming would change three protective
mechanisms for no gain.

## Steps

1. Create the project (`net8.0`, `IsPackable=false`, no test SDK) and exclude `__fixtures__/**`
   from its compile items so nested `obj/` artifacts are never globbed.
2. Add `TestPaths` and `TemporaryDirectory`.
3. `git mv` the fixtures into the project.
4. Reference the project from `Core.Tests` and `Core.Workspace.Tests` (the two suites that use temp
   dirs or fixtures); `Core.NuGet.Tests` needs neither.
5. Replace the four `FindRepositoryRoot()` copies and the fixture path literals in
   `CpmPropsReaderTests`, `CpmWriterTests`, `ProjectFileReaderTests`, `WorkspaceModelServiceTests`;
   fold the repeated temp-dir setup into `TemporaryDirectory` in the same files.
6. Update the TypeScript consumer (`host-api.test.ts`), `tsconfig.json`, `tsconfig.test.json`,
   `.vscode-test.js`.
7. Update the docs that name `tests/__fixtures__` (AGENTS.md, README.md, `.ai/project/architecture.md`)
   and add the project to `NugetPackageManager.slnx`.
8. Verify: `dotnet build` + `dotnet test` on the solution, `npm run typecheck`, `npm run test-compile`,
   and the host-api TypeScript suite.

## Constraints

- Fixtures are test *data*: no `.cs` file moves into the utility project's compile set.
- No behaviour change to any test assertion.
- Analyzer-clean (`TreatWarningsAsErrors`) — the project inherits `Directory.Build.props`.
