# Dual-Stack Documentation Alignment

Status: DONE
Started: 2026-11-01
Finished: 2026-11-01

## Steps
- [x] Step 1: .claude/settings.json sync-platforms.py
- [x] Step 2: AGENTS.md dual-stack rewrite
- [x] Step 3: .github/copilot-instructions.md rewrite
- [x] Step 4: CLAUDE.md dual-stack update
- [x] Step 5: README.md architecture/roster update
- [x] Step 6: task-execution.md + critical-rules.md agent/model fixes
- [x] Step 7: .ai/project architecture + tech-stack
- [x] Step 8: .ai/project/standards-overrides.md
- [x] Step 9: progress-file supersede + skill whitespace
- [x] Step 10: verification suite

## Verification
- validate-settings.py 6/6, validate-copilot.py 4/4, validate-agents-md.py PASS,
  validate-claude-md.py PASS, validate-structure.sh 47/47, validate-references.sh 32/32,
  validate-tokens.sh PASS, validate-skills.py 80/80, validate-standards.py PASS
  (0 Evidence rows, 17 path claims), validate-prose.py PASS, git diff --check clean.
- Pre-existing, not caused here: validate-upgrade-script.py 11/13 — it requires the
  `product-discovery` skill, which this template never ships; validate-content.py 26 warnings.

## Notes
- Docs only; no TypeScript or C# source was changed.
- `.ai/reference/standards.md` stays TEMPLATE_OWNED; the demotion re-application step is recorded in
  `.ai/project/standards-overrides.md` (project-owned, survives upgrades).
