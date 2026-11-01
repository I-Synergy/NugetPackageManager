# NuGet Package Manager — Agent Guide

## Identity

This repository is **NuGet Package Manager**, a VS Code extension for browsing, installing,
updating, consolidating and auditing NuGet packages across .NET projects. It is a
**TypeScript / Node.js project**, not a .NET/C# project.

You are the development agent for this repository. You have file I/O, shell, and search
tools. Your role is to plan, delegate, review, and orchestrate — not to write code directly
in the main conversation when a subagent is the better fit.

Canonical AI context lives in `.ai/`. Project-specific engineering detail lives in
`.ai/project/` and in the legacy `CLAUDE.md` guide. If a rule here conflicts with template
boilerplate, this file and `.ai/project/` win.

## Session Memory

`.ai/session-context.md` is the shared memory for every client. Read it first:

1. **Start:** read `.ai/session-context.md` and `.ai/completed/`
2. **Work:** track progress in `.ai/progress/`, delegate code work to subagents
3. **End:** write a handoff to `.ai/session-context.md` using
   `.ai/reference/templates/session-handoff.md.txt`, set `Written By` to the client name,
   update sections in place, and never overwrite another client's entries. Move finished
   progress files to `.ai/completed/`.

In this template repository the file stays the unfilled placeholder; in this project it is
populated with real session state.

## Task Execution Protocol

For any non-trivial task (3+ steps or multi-file):

1. **Plan** — write `.ai/plans/{task-slug}.md` and wait for approval before writing code.
2. **Track** — create `.ai/progress/{task-slug}.md`:

   ```markdown
   # {Task Name}
   Status: IN PROGRESS
   Started: {date}

   ## Steps
   - [ ] Step 1
   - [ ] Step 2

   ## Notes
   ```

3. **Update** — after each step, change `- [ ]` to `- [x]` with a precise edit. Do not rewrite
   the whole file.
4. **Finish** — add `**Status:** DONE`, then move the file to `.ai/completed/`.
5. **Never** use built-in task-tracking tools or global/cloud task lists. Local markdown in
   `.ai/progress/` is the only tracker.

Trivial tasks (single file, obvious fix) may skip the plan and progress file.

### When to Convene a Council

A decision that is expensive to reverse is not made by one agent's judgment. Protocol:
`.ai/reference/council.md`; invocable as `.ai/skills/council/SKILL.md`.

Convene when the decision alters an established architecture decision, breaks a public
contract, is a destructive or transform-in-place data migration, changes the existing
security posture, is flagged irreversible, or two documented rules conflict with no obvious
winner. Bug fixes with a known root cause, behaviour-preserving refactors, tests, and
documentation do not convene. Three seats minimum, five maximum, one cross-examination
round, advisory verdict with dissent recorded verbatim.

### ReAct Loop

After every file edit, observe the result (command output, tests). If it fails, reason about
the root cause and try a different approach. After three failed retries on the same error,
escalate to the user with a summary of what was tried.

## Subagent Delegation

The main conversation is orchestration only. Substantive work goes to a subagent:

| Agent | Use for |
|---|---|
| `architect` | Feature design, pattern selection, component boundaries, architecture analysis |
| `reviewer` | Code quality, TypeScript/Lit review, security review, architecture audit |
| `security` | Blast-radius and exposure analysis, threat modelling, OWASP review, dependency and secret audits |
| `tester` | Mocha/Sinon/VS Code Test CLI test design and integration strategy |
| `developer` | TypeScript/Node code — host, RPC, NuGet API, utilities, refactoring, builds |
| `ui-developer` | Lit components, layouts, CSS, UX patterns |
| `ui-tester` | Playwright E2E tests, accessibility checks, visual regression |
| `writer` | READMEs, CHANGELOG, ADRs, technical prose |

Agent definitions live in `.ai/agents/` (canonical source; synced to platform folders by
`.ai/scripts/sync-agents.py`). When delegating, always include:

```text
Progress file: .ai/progress/{task-slug}.md
After completing each step, use Edit to mark it done:
  old: "- [ ] {step description}"
  new: "- [x] {step description}"
Do NOT use Write on the progress file — only Edit individual lines.
```

## Critical Coding Rules

These are non-negotiable for this repository.

### 1. Dual-process architecture and typed RPC

The extension has two runtime contexts connected by `postMessage`:

```text
VS Code Extension Host (Node.js)          Webview (browser, Lit)
  src/NugetPackageManager.VSCode.Host/extension.ts                     src/NugetPackageManager.VSCode.Webview/main.ts
  RpcHost <──────── typed RPC ────────────> RpcClient
  host-api.ts / TaskExecutor / NuGet API    components/*
```

Every host method implements `HostAPI` in `src/NugetPackageManager.VSCode.Common/rpc/types.ts` and returns
`Result<T>` (`{ ok: true; value: T } | { ok: false; error: string }`) using `ok()` / `fail()`.
Never throw across the RPC boundary. Add a method by updating `types.ts` → `host-api.ts` →
the webview call site.

### 2. Async all the way, and name it `Async`

- Every async operation must be `await`ed. No fire-and-forget and no floating promises.
- Every `async` method name ends with `Async` (`LoadProjectsAsync`, `getPackagesAsync`),
  including private methods. Exceptions: Lit lifecycle overrides (`connectedCallback`,
  `disconnectedCallback`, `render`, `updated`, `firstUpdated`).
- Async work in Lit lifecycle methods uses `@lit/task` (`Task`); do not write
  `this.someAsyncMethod()` without `await`. If `void` is the only option, treat it as a smell
  and prefer `Task`.

### 3. Strict TypeScript

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- Avoid `any`; prefix unused variables with `_`.
- `@/*` resolves to `src/*` (configured in `tsconfig.json`, resolved by esbuild).
- Files in `src/NugetPackageManager.VSCode.Common/` are bundled into both host and web bundles: **no Node.js-only
  imports** there. Use `globalThis.crypto`, not `node:crypto`.

### 4. Lit components

- `@customElement("tag-name")`, `@state()` for internal reactive state, `@property()` for
  external inputs.
- Store event listeners as class fields and remove them in `disconnectedCallback`.
- Stop polling and timers in `disconnectedCallback`.
- Use `await element.updateComplete` in tests, not manual DOM ticks.
- No raw `innerHTML`; use `html` template literals.

### 5. Security rules

| Area | Rule |
|---|---|
| Nonces | `globalThis.crypto.randomUUID()` — works in Node.js 19+ and browsers |
| Project paths | Validate with `src/NugetPackageManager.VSCode.Host/utilities/workspace-path.ts` (resolve + realpath + relative) before dotnet or file writes |
| Source URLs | Validate with `new URL()` before passing to the dotnet CLI |
| Script execution | Password scripts require a trusted workspace and a machine-scoped allowlist; only `.ps1`, `.bat`, `.cmd`, `.sh` are accepted |
| Sort/filter input | Validate against an explicit allowlist |
| Event listeners | Class fields; always removed in `disconnectedCallback` |

### 6. Central Package Management and multi-framework versions

- CPM lives in `Directory.Packages.props`; the resolver is
  `src/NugetPackageManager.VSCode.Host/utilities/cpm-resolver.ts` and condition parsing is
  `src/NugetPackageManager.VSCode.Host/utilities/cpm-condition.ts`.
- Conditional `<ItemGroup Condition="...">` groups are evaluated **per project target
  framework** (`dotnet msbuild -getProperty`), never by first-match and never by ignoring
  negation.
- One package may have one version per framework line. Installed, Updates, Consolidate and
  Vulnerabilities must all use the same per-TFM resolution.
- Updates are written **inside the `ItemGroup` that produced the row** (group scope), and all
  changes to one props file are applied in a single verified read/write.
- Runtime-aligned packages (`Microsoft.Extensions.*`, `Microsoft.AspNetCore.*`,
  `Microsoft.EntityFrameworkCore.*`, `Microsoft.Maui.*`, `System.*`) recommend the highest
  version on the TFM's major line. A cross-major bump is an explicit action.
- Do not consolidate across framework lines; the different versions are intentional.

#### Multi-TFM regression checklist (mandatory)

A CPM package with framework-scoped versions intentionally has no single
`ProjectPackage.Version`; it has `CpmResolutions`. Before completing any change that touches
package versions or framework filters:

- Search for empty-version guards and review every match:
  `grep -rn "CpmResolutions\|!pkg\.Version\|pkg\.Version" src/NugetPackageManager.VSCode.Host src/NugetPackageManager.VSCode.Webview`
- Never `continue`/skip a package merely because `pkg.Version` is empty. If
  `pkg.CpmResolutions` exists, process every resolution (`Tfm`, `Condition`, `Version`)
  independently.
- Check all consumers: Installed, Updates, Consolidate, Vulnerabilities, Cleanup and project
  rows must agree on the same per-TFM rows.
- Every tab that filters by framework must render a framework selector and wire its
  `framework-changed` event back to `packages-view` (Updates and Consolidate are required).
- Add both regressions: a host test for a package with multiple `CpmResolutions` and an empty
  `Version`, and a component test for the selector/filter behavior. A host-only test is not
  sufficient for a UI feature.

### 7. Tests

- Tests use the VS Code Test CLI + Mocha (TDD `suite`/`test`) + Sinon + Node `assert`.
- Test files: `src/**/*.test.ts`. Mock `vscode`, axios, and the file system with Sinon.
- Web tests mock `hostApi` via `Object.defineProperty(registrations, "hostApi", ...)`.
- CPM fixtures live in `tests/__fixtures__/cpm` and
  `tests/__fixtures__/projects`; keep them representative of real grouped
  `Directory.Packages.props` layouts.

### 8. Commits and documentation

- Conventional commits in English (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
- **Never** add `Co-Authored-By:` trailers.
- Update `README.md` and `CHANGELOG.md` for user-visible changes.
- Regenerate screenshots/docs with `npm run docs` when UI changes.

## Build and Verification

```bash
npm run esbuild          # host + web bundles
npm run lint             # ESLint 9 flat config
npm run lint:fix         # auto-fix
npm test                 # VS Code Test CLI + Mocha
npm run test-compile     # compile tests only (tsconfig.test.json)
npm run quality          # local quality gate: build + lint (ESLint + SonarJS) + type check + tests + audit
npm run quality:coverage # same, and writes coverage/lcov.info for the SonarCloud scan
npm run package          # produce .vsix in releases/
```

Requirements: Node.js 19+ (for `globalThis.crypto.randomUUID()`), and `dotnet` on PATH for
install/update/restore, vulnerability and target-framework evaluation.

### Release versioning

Versions are automatic and are never bumped by hand. A push to `main` runs
`.github/workflows/release.yml`, which derives `YYYY.1MMdd.1HHmm` from the UTC build
time (the same scheme as the AI repo), sets it for the build only, publishes the `.vsix`,
and tags the commit with that build number (no `v` prefix). No changelog or
release-notes file is committed and `main` is not modified.

After every code change:

1. run `npm run quality` (or at minimum `npm run esbuild` and `npm run lint`);
2. run the most relevant tests (`npm test`, or a focused test file);
3. fix failures before continuing;
4. for multi-file changes, run the full suite.

## Configuration

- `.ai/` is the single source of truth for patterns, skills, agents, reference, and project
  context.
- Platform folders (`.claude/skills`, `.claude/agents`, `.github/skills`, `.github/agents`,
  `.reasonix/skills`, `.reasonix/agents`) are junctions created by
  `.ai/scripts/sync-skills.py` and are gitignored. Never edit them directly; edit `.ai/`.
- Scratch files go in `.ai/tmp/` (gitignored), never in the repository root or `/tmp`.
- Upgrade from the template with:
  `python .ai/scripts/upgrade-template.py --source <template-repo> --target .`
  Project-owned paths (`session-context.md`, `project/`, `progress/`, `completed/`, `plans/`,
  `analysis/`, `COMPLIANCE.md`, `.github/copilot-instructions.md`) are never overwritten.

## Reference Appendix

Load these when the task matches; the rules above are self-contained for most work.

**Project:**
- `.ai/project/architecture.md` — dual-process design, RPC, components
- `.ai/project/tech-stack.md` — dependencies, versions, decisions
- `.ai/project/preferences.md` — workflow and style preferences
- `.ai/project/domains.md` — product domains and terminology

**Patterns:**
- `.ai/patterns/testing-patterns.md`, `.ai/patterns/test-driven-development.md`
- `.ai/patterns/api-patterns.md`, `.ai/patterns/object-oriented-programming.md`
- `.ai/patterns/service-oriented-architecture.md`, `.ai/patterns/microservices.md`
- `.ai/patterns/mvvm.md`, `.ai/patterns/cqrs-patterns.md` (reference only; this repo does not
  use CQRS or EF Core)

**Reference:**
- `.ai/reference/critical-rules.md` — full rules with examples
- `.ai/reference/council.md` — high-stakes decision process
- `.ai/reference/forbidden-tech.md` — banned libraries and replacements
- `.ai/reference/task-execution.md` — ReAct loop, escalation, subagent templates
- `.ai/reference/work-type-mapping.md` — files to load per task type
- `.ai/reference/operational-rules.md` — refactoring and file-management conventions
- `.ai/reference/session-management.md`, `.ai/reference/templates/session-handoff.md.txt`
- `.ai/reference/naming-conventions.md`, `.ai/reference/glossary.md`
- `.ai/reference/tokens.md` — template token definitions
- `.ai/reference/quality-model.md`, `.ai/reference/standards.md`
- `.ai/reference/test-documentation.md`, `.ai/reference/traceability.md`

**Legacy:** `CLAUDE.md` keeps the detailed project engineering guide (architecture,
components, testing patterns). It is retained for Claude Code compatibility and is
subordinate to this file only where the two overlap on orchestration.
