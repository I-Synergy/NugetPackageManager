# Effective CPM versions via MSBuild

Status: DONE
Started: 2026-11-01
Finished: 2026-11-01
Plan: `.ai/plans/cpm-effective-version-evaluation.md`

## Steps

- [x] Approve plan
- [x] Add `CpmEvaluation`, `ICpmEvaluator`, `CpmEvaluator` in Core.Workspace (`PropertyReference` deferred to the write half)
- [x] Wire MSBuild evaluation into `WorkspaceModelService` (CPM flat map, per-TFM resolutions, non-CPM `PackageReference`) with `$(` detection and cache
- [x] Add optional effective-version map to `CpmPropsReader.ResolveVersions` and `ProjectFileReader.Read`
- [x] Update `CpmWriter` to rewrite a pure `$(Name)` property definition wherever MSBuild defines it, with verification and workspace containment
- [x] Add core tests (evaluator parsing, workspace model with fake evaluator/fallback, writer property updates, project reader, property locator, preprocessed parser)
- [x] Add E2E case with a variable in `Directory.Packages.props` / `Directory.Build.props`
- [x] Update README and CHANGELOG
- [x] Run `dotnet build`/`dotnet test`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run quality`

## Notes

- User decisions: always update the property (even when shared); evaluate both CPM and project
  `PackageReference` versions; silent raw-XML fallback on evaluation failure; **write scope C** —
  edit whichever file MSBuild imports defines the property, extending snapshot/rollback; per-TFM
  updates write a literal so other frameworks are not bumped.
- Property definitions are located from `dotnet msbuild -pp` boundary comments; only the last
  unconditional definition is eligible, and only inside a workspace root.
