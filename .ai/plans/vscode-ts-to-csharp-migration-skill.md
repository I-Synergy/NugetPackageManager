# Skill: converting a TypeScript VS Code extension to a C# sidecar architecture

Status: IN PROGRESS
Started: 2026-11-02

## Goal

Create the skill the user actually asked for: a playbook for converting a **whole** TypeScript
VS Code extension to the dual-runtime architecture used by NuGet Package Manager — thin Node
host adapter + .NET sidecar owning the domain logic — reusable across several extensions.

Canonical location: `D:\Projects\Github\AI\.ai\skills\vscode-ts-to-csharp-migration\` (shareable
template repo), mirrored into this project's `.ai/skills/`.

## Grounding

Written from this repository's real migration, not from theory:

- `.ai/plans/ts-to-csharp-migration.md` (waves A–F, boundary rules, module inventory)
- `.ai/progress/nuget-core-sidecar-slice.md` (sidecar skeleton, client, adapter)
- `.ai/completed/rpc-timeout-detach-and-batch-jobs.md` (timeout vs cancellation)
- `.ai/completed/sidecar-packaging-comparison.md` (R2R/trimming measurements)
- `src/NugetPackageManager.Core/Program.cs`, `Protocol/NdjsonServer.cs`, `Protocol/Rpc*.cs`
- `src/NugetPackageManager.VSCode.Host/nuget/core-client.ts`, `core-process.ts`
- `package.json` (`build:core`, `quality`, `package`)

## Steps
- [ ] SKILL.md (workflow, boundary rules, phases, pitfalls, checklist)
- [ ] references/architecture-and-transport.md
- [ ] references/porting-waves.md
- [ ] references/packaging-and-cutover.md
- [ ] assets/templates (NdjsonServer.cs, Program.cs, Core.csproj, core-client.ts)
- [ ] scripts/inventory.mjs (which modules import `vscode`, line counts, wave candidates)
- [ ] Register in AI repo README; validate with `.ai/tests/validate-skills.py`
- [ ] Mirror into `.ai/skills/` here; verify identical

## Non-goals

- Not a benchmarking skill (that is `vscode-csharp-sidecar-benchmark`).
- No change to this repository's source, tests or build config.
