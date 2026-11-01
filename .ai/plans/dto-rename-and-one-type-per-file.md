# One Type Per File + `*Dto` Suffix Removal

Status: DONE (2026-11-01)
Date: 2026-11-01

## Rules being enforced

- `.ai/reference/critical-rules.md` rule 10 — one type per file.
- `.ai/reference/naming-conventions.md` — DTO / Model types are `{Entity}` with no suffix.

## Scope decisions (confirmed by the user)

| Decision | Choice |
|---|---|
| Scope | Whole of `src/` plus the one offending test file |
| What counts as a type | classes, records, structs (interfaces, enums and type aliases may share a file) |
| `*Dto` replacements | `Package`, `PackageDetails`, `PackageDependencyGroup`, `PackageDependency`, `DependencyIssue` |
| Nested types | top-level types only; private nested helpers stay with their owner |

## Phase 1 — `*Dto` renames

| Old | New | File |
|---|---|---|
| `PackageDto` | `Package` | `Core.NuGet/Models/PackageDtos.cs` |
| `PackageVersionRef` | unchanged | same file |
| `PackageDetailsDto` | `PackageDetails` | same file |
| `PackageDependencyGroupDto` | `PackageDependencyGroup` | same file |
| `PackageDependencyDto` | `PackageDependency` | same file |
| `DependencyIssueDto` | `DependencyIssue` | `Core.Workspace/Dependencies/AssetsGraph.cs` |

Call sites: `Core.NuGet/Sources/{INuGetSource,HttpNuGetSource,PackageMapping}.cs`,
`Core/DependencyHandlers.cs`, `Core.Workspace/Dependencies/AssetsGraph.cs`,
`tests/NugetPackageManager.Core.Tests/{DependencyHandlersTests,NuGetCoreHandlersTests}.cs`.

The TypeScript side already calls this shape `Package`, so the rename aligns both halves.

## Phase 2 — C# file splits (14 files, all top-level types to their own file, same namespace)

| File | Types to extract |
|---|---|
| `Core/Diagnostics/DotnetFailureClassifier.cs` | `DotnetFailureContext`, `DotnetFailureInfo` |
| `Core/Diagnostics/RestoreOutput.cs` | `RestoreConstraint`, `RestoreConflict`, `RestoreConflictInfo` |
| `Core/Protocol/RpcContracts.cs` | `RpcRequest`, `RpcResponse`, `RpcError`, `RpcException`, `ProtocolJson` |
| `Core/Toolchain/GlobalJson.cs` | `GlobalJsonSettings`, `GlobalJsonUpdateResult` |
| `Core/Toolchain/ToolchainAnalysis.cs` | `InstalledSdkInfo`, `ToolchainIssueInfo`, `ToolchainHealthInfo`, `CommandOutput`, `ToolchainProbeInput` |
| `Core.NuGet/Configuration/NuGetConfigModels.cs` | all 8 types, one file each |
| `Core.NuGet/Models/PackageDtos.cs` | 5 types, one file each (file deleted) |
| `Core.Workspace/Cpm/CpmCondition.cs` | `ConditionNode`, `LiteralNode`, `NotNode`, `AndNode`, `OrNode`, `CompareNode`, `CallNode`, `PropertyNode` |
| `Core.Workspace/Cpm/CpmPropsReader.cs` | `CpmFrameworkEntry`, `CpmPackageMap`, `CpmVersionResolution` |
| `Core.Workspace/Cpm/CpmWriter.cs` | `CpmVersionChange` |
| `Core.Workspace/Dependencies/AssetsGraph.cs` | `DependencyAnalysis`, `RestoredDirectDependencies`, `AssetsDocument`, `AssetsProject`, `AssetsProjectFramework`, `AssetsDirectDependency`, `AssetsTargetEntry` |
| `Core.Workspace/Dependencies/RequirementClosure.cs` | `SelectedPackage`, `ClosureDependency`, `ClosureConflict`, `ClosureResult`, `RequirementOrder` |
| `Core.Workspace/Models/ProjectModels.cs` | `ProjectModel`, `ProjectPackageModel`, `CpmResolutionModel` |
| `Core.Workspace/TargetFrameworks/TargetFrameworkResolver.cs` | `TargetFrameworkInfo` |

The extraction keeps each remaining file named after the type it still owns (the static
`*Analyzer`/`*Writer`/`*Resolver` service class). Private nested helpers (`FailureBase`,
`CoherencePlan`, `Token`, `ConditionParser`, `ItemGroupBlock`, `GraphNode`, `ClosureItem`,
`CacheEntry`) stay where they are.

## Phase 3 — TypeScript file splits

| File | Extraction |
|---|---|
| `VSCode.Host/extension.ts` | `NugetWebviewManager` → `webview-manager.ts`, `NugetLauncherTreeProvider` → `launcher-tree-provider.ts`; `extension.ts` stays the esbuild entry point and keeps `activate`/`deactivate` |
| `VSCode.Webview/types.ts` | 7 view models → `view-models/<name>.ts`; `types.ts` re-exports so neither `@/web` imports nor tests change |

## Phase 4 — Test file

- `tests/NugetPackageManager.Core.NuGet.Tests/Sources/PackageLookupFailureTests.cs`:
  `StubHandler` → `Sources/StubHandler.cs` (`internal` in the test assembly).

## Verification

1. `grep`-based regression scan: no file under `src/` or `tests/` declares more than one
   top-level class/record/struct, and no identifier ends in `Dto`.
2. `dotnet build NugetPackageManager.slnx -c Release`
3. `dotnet test NugetPackageManager.slnx -c Release`
4. `npm run typecheck`
5. `npm run lint`
6. `npm run esbuild`
7. `npm test`
8. `npm run quality` (full gate) before declaring done.

## Risks / notes

- Renames and file moves are compile-time only: the sidecar wire format is JSON property
  names produced by `ProtocolJson`, not CLR type names, so no protocol change.
- `PackageDtos.cs` and `NuGetConfigModels.cs` disappear as file names; nothing references
  them (C# has no file-level imports).
- `types.ts` keeps re-exports, so the webview barrel import surface is unchanged.
- No user-visible change → no `CHANGELOG.md` entry; `AGENTS.md`/docs already state both rules.

## Tracking

Progress file: `.ai/progress/dto-rename-and-one-type-per-file.md`

## Delivered — deviations from this plan

1. **Three files deleted, not two.** `RpcContracts.cs` and `ProjectModels.cs` join
   `PackageDtos.cs` and `NuGetConfigModels.cs`: no type matched the file name, so every type
   moved to its own file (`RpcRequest.cs`, `RpcResponse.cs`, `RpcError.cs`, `RpcException.cs`,
   `ProtocolJson.cs`; `ProjectModel.cs`, `ProjectPackageModel.cs`, `CpmResolutionModel.cs`).
2. **Four more TypeScript files were split.** The first inventory only caught
   `extension.ts` and `types.ts`; `core-client.ts` (`CoreError` → `nuget/core-error.ts`),
   `operation-jobs.ts` (`JobRegistry` → `utilities/job-registry.ts`, with `JobSnapshot`,
   `JobReporter` and `JobRunner` moving with it), `password-script-executor.ts`
   (`PasswordScriptTerminal` → `utilities/password-script-terminal.ts`) and `task-executor.ts`
   (`DotnetError` → `utilities/dotnet-error.ts`) each held two classes.
   Public import paths are preserved through re-exports, so no test or host call site changed.
3. **`PackageLookupFailureTests.cs` unchanged.** `StubHandler` is a nested private helper and
   reads `SourceUrl`/`ServiceIndex` from its owner; the agreed "top-level types only" rule
   keeps it where it is.

Verification: 0 multi-class files, 0 `Dto` identifiers, `dotnet test` 204/204,
`npm test` 358 passing, `npm run quality` PASS.
