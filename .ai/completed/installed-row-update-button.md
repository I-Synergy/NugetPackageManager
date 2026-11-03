# Installed Row Update Button
Status: DONE
Started: 2026-11-03

Plan: `.ai/plans/installed-row-update-button.md`

## Steps
- [x] `package-row`: actionable update button, `updating` state, `package-update-requested` event
- [x] `packages-view`: Installed update handler (targets, batch job, status/error line)
- [x] Tests: `package-row.test.ts` and `packages-view.test.ts`
- [x] Docs: CHANGELOG and README Installed section
- [x] Verification: focused tests, typecheck, lint, `npm test`, `npm run quality`

## Notes
- Implementation, tests and docs are in place; the two `sonarjs/no-nested-conditional` warnings the
  first pass introduced were removed and pinned projects are excluded from the write.
- `npm run typecheck` PASS, `npm run lint` PASS (0 problems), `npm test` 484 passing.
- `npm run quality` 7/8: Build, Lint + SonarJS, Type check, C# tests, Compile tests, Tests and
  Dependency audit pass. `C# build` fails with `NU1301: The local source
  'C:\Program Files (x86)\Microsoft SDKs\NuGetPackages\' doesn't exist` — a machine-level NuGet
  source pointing at a missing folder, unrelated to this TypeScript change (the C# projects were
  not touched).

## Follow-up corrections
- [x] `package-row`: `renderVersionContent` computes a local `updateIndicator` and renders
  `${hasUpdate ? updateIndicator : nothing}` — no nested conditional (`sonarjs/no-nested-conditional`).
- [x] `packages-view`: `renderInstalledTab` renders `${this.renderInstalledUpdateStatus()}`, a private
  helper returning the error div, else the status div, else `nothing`.
- [x] `packages-view`: `buildInstalledUpdateEntries` skips pinned packages
  (`if (!installed || installed.IsPinned) continue;`) and requires `resolution.Condition` on a
  framework-scoped row, so scoped rows always emit `{ CpmCondition, CpmTfm, Scope: 'group' }`.
- [x] Tests: `Installed row update` is now a top-level sibling suite, plus a test that a pinned
  project is excluded while an unpinned project that has the package is included.
