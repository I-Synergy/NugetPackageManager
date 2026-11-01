# One Type Per File + `*Dto` Suffix Removal

Status: DONE
Started: 2026-11-01

Plan: `.ai/plans/dto-rename-and-one-type-per-file.md`

## Steps
- [x] Phase 1 — rename the 5 `*Dto` types and update all call sites
- [x] Phase 2 — split the 14 multi-type C# files (top-level types only)
- [x] Phase 3 — split `VSCode.Host/extension.ts` and `VSCode.Webview/types.ts`
- [x] Phase 4 — extract `StubHandler` from `PackageLookupFailureTests.cs`
- [x] Phase 5 — verify: multi-type/Dto scan, dotnet build + test, npm typecheck/lint/esbuild/test, npm run quality

## Notes

- Verified: 0 files under `src/` and `tests/` declare more than one top-level
  class/record/struct; 0 identifiers ending in `Dto` remain.
- `dotnet test` 204/204 (Core 73, Core.NuGet 42, Core.Workspace 89); `npm test` 358 passing;
  `npm run quality` PASS (8 steps).
- Deviations from the plan, all recorded in `.ai/plans/dto-rename-and-one-type-per-file.md`:
  - `RpcContracts.cs` and `ProjectModels.cs` were also deleted (no type matched the file name,
    so every type moved to its own file).
  - Four further host files held two classes each and were split too: `core-client.ts`,
    `operation-jobs.ts`, `password-script-executor.ts`, `task-executor.ts`.
  - `PackageLookupFailureTests.cs` was left unchanged: `StubHandler` is a *nested private*
    helper, which the agreed rule keeps with its owner.

