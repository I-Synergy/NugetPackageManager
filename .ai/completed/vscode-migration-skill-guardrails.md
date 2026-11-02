# Migration skill: generated C# must follow the repository's layout, rules and guardrails
Status: DONE
Started: 2026-11-02
Completed: 2026-11-02

## Change

Extended `vscode-ts-to-csharp-migration` (canonical in `D:\Projects\Github\AI\.ai\skills\`, mirrored
into this project) so the C# it generates is forced onto the repository's conventions rather than
invented per extension.

Added:

- `references/csharp-project-conventions.md` — layout (`src/<Product>.Core*`, one
  `tests/<Name>.Tests` per source project, `TestUtilities` for fixtures), root policy in
  `Directory.Build.props`, central versions in `Directory.Packages.props`, csproj rules,
  naming (`Async` suffix, camelCase private fields per `.editorconfig`, no `Dto` suffix, enums
  plural except `*Status`), MSTest conventions (`// File:` + `// Traces:`, `[TestCategory]`,
  `Method_Scenario_ExpectedResult`), forbidden packages, and the audit.
- `assets/templates/Directory.Build.props.txt`, `Directory.Packages.props.txt` — the root policy
  and central versions, including the `Fixtures/**` opt-out.
- `assets/templates/Library.csproj.txt`, `Tests.csproj.txt`, `TestClass.cs.txt`; `Core.csproj.txt`
  reduced to the minimal form (policy settings no longer duplicated per project).
- `assets/templates/Protocol/` — `NdjsonServer`, `RpcRequest`, `RpcResponse`, `RpcError`,
  `RpcException`, `ProtocolJson`, split so the templates themselves obey one-type-per-file.
- `scripts/audit-csharp-projects.mjs` — no-build audit: root policy, CPM (no `Version=`), MSTest
  only, `UseAppHost=false`, no trimming/R2R, solution registration, test pairing, async naming,
  `Dto` suffix, one type per file (warning; `--strict` promotes it), test headers and naming.
- SKILL.md: a "generated projects must fit the repository" block in Phase 1 referencing the
  conventions, plus checklist rows and the audit command.

## Verification

- `node --check` passes on both scripts.
- Audit run against this repository: **0 failures, 3 warnings**, which surfaced three real,
  pre-existing deviations (not introduced here):
  1. `src/NugetPackageManager.Common/NugetPackageManager.Common.csproj` is not registered in
     `NugetPackageManager.slnx` (reached only transitively).
  2. The same project repeats `<Nullable>` and `<ImplicitUsings>` instead of inheriting the root
     policy.
  3. `src/NugetPackageManager.Core.NuGet/Sources/NuGetSourceProvider.cs` holds
     `INuGetSourceProvider` and `NuGetSourceProvider` in one file.
- `.ai/tests/validate-skills.py`: 49 skills, 0 errors.
- `pytest -k "yaml or file_references or directory_structure"`: 3 passed.
- `diff -r` confirms the template-repo and project copies are identical (21 files).
- No production source, test, fixture or build file was changed.

## Notes

- The audit deliberately downgrades two checks to warnings (solution registration, one type per
  file) because this repository itself has tolerated counterexamples; the skill states the rule and
  reports the deviation without blocking a run.
- Neither repository has been committed.
