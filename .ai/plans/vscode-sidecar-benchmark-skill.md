# Skill: VS Code extension + C# sidecar benchmark playbook

Status: IN PROGRESS
Started: 2026-11-02

## Goal

Capture the exercise just completed — comparing a TypeScript implementation in the VS Code
extension host against its C# sidecar replacement for **time and memory**, including the
deleted-baseline recovery, parity gate, sidecar RSS measurement and reporting — as a reusable,
extensive skill under `.ai/skills/`.

## Steps
- [ ] Write `.ai/skills/vscode-csharp-sidecar-benchmark/SKILL.md`
- [ ] Add `references/measurement-metrics.md`
- [ ] Add `references/sidecar-transport-and-rss.md`
- [ ] Add `references/reporting-template.md`
- [ ] Port the harness scripts (workload generator, TS harness, parity, sidecar probe, rounds) and the C# harness template
- [ ] Verify the skill loads (frontmatter valid, links resolve) and no repo source changed

## Non-goals

- No change to `src/`, tests, fixtures or build config.
- No new dependency in the project; scripts are self-contained Node/`dotnet` templates.
