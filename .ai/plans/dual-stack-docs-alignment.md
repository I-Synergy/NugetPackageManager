# Plan: dual-stack documentation alignment

Status: APPROVED (user: "Fix everything, but note this project contains c# and typescript projects")

## Problem

The `verify-config` audit (2026-11-01) found that the AI context still describes a
TypeScript-only, pre-refactor tree. The repository is a dual-language project:

- **C# core** — `src/NugetPackageManager.Core`, `.Core.NuGet`, `.Core.Workspace`, run as a
  sidecar process from `dist/core` (`NugetPackageManager.slnx`, three MSTest projects).
- **TypeScript extension** — `src/NugetPackageManager.VSCode.{Common,Host,Webview}`, tests in
  `tests/NugetPackageManager.VSCode.Tests` (Mocha/Sinon), bundled by esbuild.

## Findings addressed

1. `.claude/settings.json` hooks call the deprecated `sync-skills.py` (`validate-settings.py` FAIL).
2. `.github/copilot-instructions.md` is not word-for-word identical to AGENTS.md's
   `## Session Memory`, and describes `src/{host,web,common}` that no longer exist.
3. AGENTS.md: "not a .NET/C# project", `@/*` alias, `src/**/*.test.ts`, missing
   `cpm-resolver.ts`/`cpm-condition.ts`, sidecar absent from the architecture.
4. AGENTS.md: no MANDATORY progress-file wording, no HARD RULE subagent section, `designer`
   missing from the roster.
5. README.md: stale architecture/source layout, "tests live alongside source", no agent roster.
6. CLAUDE.md: same drift.
7. `.ai/reference/task-execution.md` names a `programmer` subagent "(Haiku model)";
   `.ai/reference/critical-rules.md` names "(Sonnet)"/"(Pro)".
8. `.ai/progress/async-naming-refactor.md` still active against pre-refactor paths.
9. `.ai/skills/design-interrogation/SKILL.md:71` trailing whitespace.
10. `.ai/project/architecture.md` / `tech-stack.md` omit the C# core.
11. Standards manifest ownership: an upgrade restores the `Evidence` row.

## Steps

1. `.claude/settings.json` → `sync-platforms.py`.
2. AGENTS.md → dual-stack identity, MANDATORY tracking, HARD RULE delegation, 9-agent roster,
   correct aliases/test paths/CPM modules, C# build commands, `sync-platforms.py`.
3. `.github/copilot-instructions.md` → rewritten, Session Memory identical to AGENTS.md.
4. CLAUDE.md → dual-stack build/test/architecture.
5. README.md → architecture, source layout, test layout, prerequisites, agent roster.
6. `.ai/reference/task-execution.md` + `.ai/reference/critical-rules.md` → agent roster, no model names.
7. `.ai/project/architecture.md` + `tech-stack.md` → C# core section and dependencies.
8. `.ai/project/standards-overrides.md` → project-owned record of the row-1 demotion (template-owned
   manifest is restored by an upgrade).
9. `.ai/progress/async-naming-refactor.md` → SUPERSEDED; skill whitespace fix.
10. Verify: `validate-settings.py`, `validate-copilot.py`, `validate-agents-md.py`,
    `validate-structure.sh`, `validate-standards.py`, `validate-skills.py`, `git diff --check`.

## Constraints

- Session Memory strings required by `validate-settings.py`:
  "`.ai/session-context.md` is the shared memory for every client" and
  "never overwrite another client's entries".
- `.ai/reference/standards.md` and `.ai/tests/` are TEMPLATE_OWNED — keep the manifest edit, record
  the re-application step in the project-owned note instead of moving ownership.
- Documentation only: no TypeScript/C# source changes.
