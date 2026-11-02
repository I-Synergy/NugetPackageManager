# Skill: converting a TypeScript VS Code extension to a C# sidecar architecture
Status: DONE
Started: 2026-11-02
Completed: 2026-11-02
Plan: `.ai/plans/vscode-ts-to-csharp-migration-skill.md`

## Result

New skill `vscode-ts-to-csharp-migration`, canonical in
`D:\Projects\Github\AI\.ai\skills\vscode-ts-to-csharp-migration\` and mirrored byte-for-byte into
this project's `.ai/skills/`.

Contents:

- `SKILL.md` (308 lines) — the VS Code extension boundary, what stays in the host, six boundary
  rules, phases 0–8 (inventory → sidecar skeleton → host client → contract → first wave → long
  operations → packaging → cutover → verification gate), a pitfalls table and a checklist.
- `references/architecture-and-transport.md` — NDJSON wire shapes, handshake, concurrency,
  cancellation, error codes, client lifecycle, security boundary, fake-sidecar testing.
- `references/porting-waves.md` — inventory method, wave selection with the real five-wave split,
  per-wave loop, parity techniques (golden files first), test-seam migration, deliberate remainders.
- `references/packaging-and-cutover.md` — `dotnet publish -o dist/core`, `vscode:prepublish`, the
  measured publish-mode comparison, VSIX contents, runtime prerequisites, activation/deactivation,
  feature flag and cutover, CI.
- `assets/templates/` — `NdjsonServer.cs.txt`, `Program.cs.txt`, `Core.csproj.txt`,
  `core-client.ts.txt`.
- `scripts/inventory.mjs` — reports per-module lines, `vscode`/webview/Node-only usage, movable
  totals, so each extension can be sized before any C# is written.

Also registered in the template's `README.md` (.NET Implementation table) and cross-linked from
`vscode-csharp-sidecar-benchmark` (measurement) so the two skills point at each other.

## Grounding

Facts, numbers and rules come from this repository's completed migration
(`.ai/plans/ts-to-csharp-migration.md`, `.ai/completed/*`, the core/client sources), not from
generic advice: the 8-of-30 `vscode`-import split, ≈5,775 movable lines, the one-RPC-per-operation
rule, the RPC timeout/cancel dichotomy, and the 4.4 MB / 67 ms vs R2R / trimmed packaging results.

## Verification

- `.ai/tests/validate-skills.py` in the template repo: **49 skills, 0 errors**.
- `pytest .ai/tests/test_suite.py -k "yaml or file_references or directory_structure"`: **3 passed**.
- `node --check scripts/inventory.mjs` passes; the script was run against this extension's host
  (`41 modules, 8,868 lines, 29 movable modules, 3,398 movable lines, 12 vscode imports`).
- `diff -r` confirms the AI-repo and project copies are identical.
- No source, test, fixture or build file changed.

## Notes

- The skill is explicitly VS Code-first: extension host lifecycle, `vscode` API ownership, webview
  → host → sidecar chain, `@vscode/test-cli` suites, `context.extensionPath` and VSIX packaging are
  first-class sections rather than generic sidecar advice.
- Nothing is committed in either repository.
