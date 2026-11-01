# Project Development Preferences

This file defines how agents work in this repository. It is project-specific and applies to
all clients.

## Working Relationship

- **Communication:** direct and concise; explain trade-offs when they are material.
- **Sycophancy:** none. Challenge assumptions when evidence points the other way.
- **Timelines:** include an estimate only when asked.
- **Git co-authorship:** never add `Co-Authored-By:` trailers.

## Problem-Solving

- **Correct fixes over shortcuts**, unless the user explicitly asks for a prototype.
- **Bug fixing:** reproduce first, then fix, then add a regression test.
- **Technical debt:** acceptable only when documented and bounded.
- **Assumptions:** verify against the code; ask only for user-owned decisions.
- **"Good enough":** production-ready, with `npm run esbuild`, `npm run lint` and relevant
  tests passing.

## Development Workflow

- **Autonomy:** implement technical details; ask before architecture, data-model, security or
  public-contract changes.
- **Planning:** non-trivial tasks get `.ai/plans/{task-slug}.md` and `.ai/progress/{task-slug}.md`.
- **Progress:** update `- [ ]` → `- [x]` after each step; move finished files to `.ai/completed/`.
- **Verification:** targeted tests first, then the full suite for multi-file changes.

## Code Style

- TypeScript strict mode; avoid `any`; prefix unused identifiers with `_`.
- Every `async` method ends with `Async`; Lit lifecycle overrides are exempt.
- Host RPC methods return `Result<T>` via `ok()` / `fail()`.
- Use `@lit/task` for async work in Lit lifecycle methods.
- No Node.js-only imports in `src/NugetPackageManager.VSCode.Common/`.
- No raw `innerHTML`; use Lit templates and VS Code CSS variables.

## Documentation

- Update `README.md` and `CHANGELOG.md` for user-visible changes.
- Regenerate screenshots with `npm run docs` after UI changes.
- Keep doc identifiers (file names, method names, extension id) in sync with the code.

## Commits

- Conventional commits in English: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`.
- One logical change per commit; do not mix formatting-only changes with behavior.
