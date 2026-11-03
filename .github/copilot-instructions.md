# GitHub Copilot Instructions

<!-- ai-workspace-manager:generated-from-agents -->
<!-- Generated from AGENTS.md. Edit AGENTS.md, not this file. -->

# NuGet Package Manager — Agent Guide

## Identity

This repository is **NuGet Package Manager**, a VS Code extension for browsing, installing,
updating, consolidating and auditing NuGet packages across .NET projects. It is a
**dual-language codebase**:

- **.NET / C# core** — `src/NugetPackageManager.Core`, `src/NugetPackageManager.Core.NuGet`
  and `src/NugetPackageManager.Core.Workspace` (in `NugetPackageManager.slnx`). It owns the
  NuGet source client, `nuget.config` resolution, the project model, per-framework CPM
  resolution, the dependency operations and toolchain detection, and runs as a sidecar
  process from `dist/core`.
- **TypeScript / Node.js extension** — `src/NugetPackageManager.VSCode.Common`,
  `.VSCode.Host` and `.VSCode.Webview`. It owns VS Code activation, the typed RPC layer,
  the Lit webview, and the remaining host plumbing (local feed, SDK install, workload
  commands, core adapters).

Neither half is legacy and neither can be changed in isolation: a change to the core
contract crosses the sidecar protocol, `HostAPI` and the webview call site.

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

For any non-trivial task (3+ steps or multi-file), a plan **and** a progress file are
**MANDATORY**. The progress file is the only task tracker this repository uses.

1. **Plan** — write `.ai/plans/{task-slug}.md` and wait for approval before writing code.
2. **Track (mandatory)** — create `.ai/progress/{task-slug}.md`:

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

## Subagent Delegation (HARD RULE)

**HARD RULE:** the main conversation is orchestration only. It may read, search, plan,
review and talk to the user; it may not implement. All source edits — TypeScript **and**
C# — go to a subagent. Documentation, plans, progress files and session context are the only
files the main conversation may write itself.

Substantive work goes to a subagent:

| Agent | Use for |
|---|---|
| `architect` | Feature design, pattern selection, component boundaries, architecture analysis |
| `designer` | Visual design — colour, typography, spacing, branding, design tokens, contrast |
| `reviewer` | Code quality, TypeScript/Lit and C# review, security review, architecture audit |
| `security` | Blast-radius and exposure analysis, threat modelling, OWASP review, dependency and secret audits |
| `tester` | Mocha/Sinon and MSTest test design, integration strategy |
| `developer` | TypeScript and C# implementation — host, RPC, core handlers, adapters, refactoring, builds |
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

### 1. Two-process extension, sidecar core, typed RPC

The extension has two runtime contexts connected by `postMessage`, plus a .NET sidecar:

```text
VS Code Extension Host (Node.js)          Webview (browser, Lit)
  src/NugetPackageManager.VSCode.Host/extension.ts      src/NugetPackageManager.VSCode.Webview/main.ts
  RpcHost <──────── typed RPC ────────────> RpcClient
  host-api.ts / TaskExecutor                 components/*
        │
        │ sidecar JSON-RPC over stdio
        ▼
.NET core (dist/core, started by nuget/core-process.ts)
  src/NugetPackageManager.Core            protocol + handlers
  src/NugetPackageManager.Core.NuGet      source client, config, advisories
  src/NugetPackageManager.Core.Workspace  csproj model, CPM, TFMs, dependency graph
```

Every host method implements `HostAPI` in `src/NugetPackageManager.VSCode.Common/rpc/types.ts` and returns
`Result<T>` (`{ ok: true; value: T } | { ok: false; error: string }`) using `ok()` / `fail()`.
Never throw across the RPC boundary. Add a method by updating `types.ts` → `host-api.ts` →
the webview call site. Core capabilities are reached through `nuget/core-client.ts`
(`CoreProcess.CallAsync<T>`), and a core failure surfaces as `CoreError` with a code — never
as a crashed host.

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
- `@/common/*`, `@/host/*` and `@/web/*` resolve to the three `src/NugetPackageManager.VSCode.*`
  projects (configured in `tsconfig.base.json`, resolved by esbuild).
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

- CPM lives in `Directory.Packages.props`. The resolver is the C# core —
  `src/NugetPackageManager.Core.Workspace/Cpm/CpmCondition.cs`, `CpmPropsReader.cs` and
  `CpmWriter.cs`; the host adapters are `utilities/cpm-reader.ts`, `utilities/cpm-writer.ts`
  and `utilities/cpm-conditional.ts`. Reference: `.ai/reference/work-type-mapping.md`.
- Conditional `<ItemGroup Condition="...">` groups are evaluated **per project target
  framework** by `TargetFrameworkResolver` (`dotnet msbuild -getProperty`), never by
  first-match and never by ignoring negation.
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
  `grep -rn "CpmResolutions\|!pkg\.Version\|pkg\.Version" src/NugetPackageManager.VSCode.Host src/NugetPackageManager.VSCode.Webview src/NugetPackageManager.Core.Workspace`
  — consumer contract: `.ai/reference/critical-rules.md`.
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

- TypeScript tests use the VS Code Test CLI + Mocha (TDD `suite`/`test`) + Sinon + Node `assert`;
  C# tests use MSTest. Mock `vscode`, axios and the file system with Sinon.
- TypeScript test files live in `tests/NugetPackageManager.VSCode.Tests/**/*.test.ts` and mirror
  the `src/NugetPackageManager.VSCode.*` layout. C# test projects are
  `tests/NugetPackageManager.Core.Tests`, `.Core.NuGet.Tests` and `.Core.Workspace.Tests`.
- Web tests mock `hostApi` via `Object.defineProperty(registrations, "hostApi", ...)`.
- CPM fixtures live in `tests/NugetPackageManager.TestUtilities/Fixtures/cpm` and the
  MSBuild projects in `.../Fixtures/projects`; reach them through `TestPaths.Fixture(...)`
  from `tests/NugetPackageManager.TestUtilities`, and keep them representative of real grouped
  `Directory.Packages.props` layouts.
- A change that crosses the sidecar contract needs a core test **and** a host test.
- `npm run test:e2e` drives the real sidecar and the real `dotnet` CLI against a fixture
  project under `tests/NugetPackageManager.VSCode.Tests/e2e/` (needs `npm run build:core` and
  `dotnet` on PATH). It is opt-in and not part of `npm test`.
- Test design detail: `.ai/patterns/testing-patterns.md`.

### 8. Commits and documentation

- Conventional commits in English (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`).
- **Never** add `Co-Authored-By:` trailers.
- Update `README.md` and `CHANGELOG.md` for user-visible changes.
- Regenerate screenshots/docs with `npm run docs` when UI changes.

## Build and Verification

```bash
npm run esbuild          # host + web bundles
npm run build:core       # dotnet publish the C# sidecar to dist/core
npm run typecheck        # tsc over src and the TS test project
npm run lint             # ESLint 9 flat config
npm run lint:fix         # auto-fix
npm test                 # VS Code Test CLI + Mocha (TypeScript)
npm run test-compile     # compile tests only (tsconfig.test.json)
npm run test:e2e         # opt-in end-to-end: real sidecar + real dotnet write a fixture project
dotnet build NugetPackageManager.slnx -c Release   # C# core
dotnet test  NugetPackageManager.slnx -c Release   # MSTest
npm run quality          # quality gate: bundles + lint + typecheck + C# build + C# tests + TS tests + audit
npm run quality:coverage # same, and writes coverage/lcov.info for the SonarCloud scan
npm run package          # produce .vsix in releases/
```

Requirements: Node.js 19+ (for `globalThis.crypto.randomUUID()`), .NET SDK 8+ (the sidecar
targets `net8.0` with `RollForward=LatestMajor`), and the `dotnet` CLI on PATH — the extension
also shells out to it for restore, install/update, vulnerability and target-framework work.

`NugetPackageManager.slnx` also lists the TypeScript entry points and configs under
`/TypeScript*/` solution folders, so Visual Studio shows both halves of the repository. Those are
solution items, not MSBuild projects: `dotnet build` ignores them and the TypeScript still builds
through `npm run esbuild` / `npm run quality`.

### Release versioning

Versions are automatic and are never bumped by hand. A push to `main` runs
`.github/workflows/release.yml`, which derives `YYYY.1MMdd.1HHmm` from the UTC build
time (the same scheme as the AI repo), sets it for the build only, publishes the `.vsix`,
and tags the commit with that build number (no `v` prefix). No changelog or
release-notes file is committed and `main` is not modified.

After every code change:

1. run `npm run quality` (the gate includes the C# build and both test suites);
2. run the most relevant tests (`npm test`, `dotnet test` for core changes, or a focused test file);
3. fix failures before continuing;
4. for multi-file changes, run the full suite.

## Configuration

- `.ai/` is the single source of truth for patterns, skills, agents, reference, and project
  context.
- Platform folders (`.github/skills`, `.github/agents`, `.github/skills`, `.github/agents`,
  `.reasonix/skills`, `.reasonix/agents`) are junctions created by
  `.ai/scripts/sync-platforms.py` from the clients selected in `.ai/ai.json`, and are
  gitignored. Never edit them directly; edit `.ai/`.
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

## Installed skills and agents

<!-- ai-workspace-manager:installed:start -->
### Skills
- `android-java-bindings` — Write and repair C# bindings for Java/Kotlin Android libraries with .NET for Android. USE FOR: direct/full AAR or JAR bindings, AndroidMavenLibrary, Metadata.xml, Additions, missing generated APIs, Kotlin JVM signatures, binding-generator warnings, CS0535/CS0738/CS0534, duplicate members, EventArgs, listener Handler fields or events, and binding dependency errors XA4241/XA4242. DO NOT USE FOR: XAML data binding, AI tool bindings, iOS/Swift bindings, desktop JVM hosting, or designing a Java/Kotlin slim wrapper (use android-slim-bindings).
- `android-slim-bindings` — Create Android slim bindings for MAUI/.NET Android. USE FOR: Native Library Interop, thin Kotlin/Java wrapper design, building wrapper AARs with Gradle, Java-friendly callbacks, @JvmStatic, and dependencies of slim wrappers. DO NOT USE FOR: direct/full Java/Kotlin bindings or generated-code/Metadata.xml repairs (use android-java-bindings), iOS/macOS bindings, general MAUI apps, or NuGet packaging.
- `api-endpoints` — API endpoint creation, OpenAPI configuration, Kiota client generation, and API security hardening. Use when creating Minimal API endpoints, setting up API projects, generating Kiota clients, configuring OpenAPI/Swagger, or hardening API security (rate limiting, CORS, validation, HTTPS).
- `api-security` — API security specialist. Use for securing APIs, implementing authentication/authorization, protecting against OWASP API Top 10, or handling security best practices.
- `architect` — Solution architecture and system design expert. Use when designing system architecture, choosing technology stacks, making architectural decisions, or defining bounded contexts.
- `blazor-fluentui` — Production-ready Blazor patterns exactly as implemented inside the I-Synergy Framework UI (View<TViewModel>, ConfigureServices bootstrapper, CommonServices, Dialog/Navigation services). Use when building or debugging I-Synergy Blazor UI with View<TViewModel>, the ConfigureServices bootstrapper, CommonServices, or the Dialog/Navigation services.
- `blazor-specialist` — Blazor UI development specialist. Use for building Blazor Server or WebAssembly apps, component development, state management, or form handling.
- `blazor-theme-generator` — Generate a complete Blazor app theme (--b-* CSS custom properties for dark + light mode) from a single accent color. Trigger when the user provides an accent color for a Blazor app, says "generate a Blazor theme", "update the Blazor theme colors", "create --b-* tokens", or asks to theme their Blazor UI. Handles both hsl(H, S%, L%) and
- `book-to-skill` — Converts a technical book (PDF or EPUB) into a structured Claude Code skill — extracting frameworks, mental models, principles, techniques, and anti-patterns the author crystallized. Use when the user wants to study a book through Claude, apply an author's frameworks while working, or build a reusable knowledge base from any PDF or EPUB.
- `code-reviewer` — Code quality and architecture review specialist. Use when reviewing code for SOLID principles, CQRS patterns, security issues, or architecture compliance before merging.
- `council` — Convenes a council for a decision that is expensive to reverse — seats briefed with conflicting mandates return positions formed independently, each carrying a self-objection, and a chair synthesizes on the merits while recording dissent verbatim instead of averaging it away. Use when a change alters an established architecture decision, breaks a public contract that other code or consumers depend on, performs a destructive data migration, alters the existing security posture rather than applying the documented pattern, or when two documented rules conflict with no obvious winner. Trigger whenever the user says "run a council", "convene a council", "council this decision", "get independent positions on this", or flags a choice as irreversible. Advisory verdict, never a vote. Do not trigger for bug fixes with a known root cause, additive or backward-compatible changes, behavior-preserving refactors, tests, or documentation.
- `css-theme-generator` — Generate a full CSS custom property theme (light + dark) from a single accent color in HSL or hex. Trigger when the user provides an accent color, says "generate a theme", "create CSS tokens from this color", "build a color scale", or asks to derive a design system palette from a brand color. Handles both hsl(H, S%, L%) and
- `database-migration` — EF Core migrations and database specialist. Use when creating/applying database migrations, designing schemas, optimizing queries, or managing PostgreSQL databases.
- `design-interrogation` — Structured design interrogation — interview the user relentlessly about a plan, architecture, or technical decision until every branch of the decision tree is resolved. Consumes product-discovery output when available. Use whenever a user says "grill me", "stress-test my plan", "poke holes in this", "challenge my design", "interview me about this design", or wants a rigorous review of any design, architecture, or technical proposal — even if they don't use these exact words. Use when a plan, architecture, or technical decision needs pressure-testing before you commit to it. When in doubt, trigger this skill.
- `devflow-automation` — Automate MAUI app state through DevFlow Actions. USE FOR: `[DevFlowAction]` shortcuts, login, seed data, deep screens. DO NOT USE FOR: arbitrary methods, DI internals, UI MCP tools, connectivity, or build/deploy issues.
- `devflow-connect` — Diagnose DevFlow agent connectivity. USE FOR: `maui devflow` connection failures, agent not found, ports, adb forwarding, broker. DO NOT USE FOR: build failures, setup, visual tree, or Blazor CDP.
- `devops-engineer` — DevOps and CI/CD specialist. Use for building pipelines, containerization, infrastructure as code, or deployment automation. User-invocable only for production deployments.
- `dotnet-engineer` — .NET/C#/Blazor/MAUI development expert. Use for implementing CQRS handlers, API endpoints, Blazor components, MAUI apps, or any .NET code development tasks.
- `dotnet-workload-info` — Discover MAUI workload metadata from live NuGet APIs. USE FOR: workload manifest lookup, WorkloadDependencies.json, v3-flatcontainer, CLI-to-NuGet version conversion, Xcode/JDK/Android SDK requirements, CI sdkmanager packages, `packageid:Microsoft.Maui.Controls`. DO NOT USE FOR: installing workloads, build debugging, or app version edits.
- `gap-review` — Validates a generated or implemented solution against the original architecture document and design decisions. Run after solution-generator or after completing feature implementation to verify alignment. Trigger whenever the user says "gap review", "validate the implementation", "check against the design", or after solution generation completes. Identifies gaps, deviations, and missing decisions.
- `hugo` — Hugo static site generator with Tailwind v4, headless CMS (Sveltia/Tina), Cloudflare deployment. Use for blogs, docs sites, or encountering theme installation, frontmatter, baseURL errors.
- `integration-specialist` — External API integration specialist. Use when integrating with third-party APIs, implementing webhooks, message queues, or handling external service communication.
- `ios-slim-bindings` — Create iOS slim bindings for MAUI. USE FOR: slim iOS binding, Native Library Interop, Swift/Objective-C wrappers, XcodeGen project.yml, Podfile, CocoaPods static linking, BUILD_LIBRARY_FOR_DISTRIBUTION, XcodeProject MSBuild, `@objc`/`[Export]` selector crashes, async completion handlers. DO NOT USE FOR: Android bindings, general MAUI apps, or NuGet packaging.
- `keycloak-theme-colors` — Update the accent colors in an I-Synergy Keycloak login theme from a single base hex color. Trigger when the user provides a hex color code (like "#0078D7") for a theme, says "align colors with the logo", "update the theme colors", "set the accent to
- `maui-accessibility` — Improve MAUI accessibility. USE FOR: semantic labels, hints, headings, screen-reader focus/announcements, AutomationProperties, touch targets, decorative content, TalkBack/VoiceOver/Narrator checks. DO NOT USE FOR: general layout, automation-only tests, performance, motion and gesture design (use maui-apple-design).
- `maui-ai-debugging` — Legacy DevFlow debug skill. USE FOR: `maui-ai-debugging`, `maui devflow`, screenshots, visual tree, Blazor CDP, simulator/emulator debugging. DO NOT USE FOR: setup, desktop automation, AppleScript, host `xdotool`.
- `maui-ai-tool-bindings` — Source-generate `Microsoft.Extensions.AI` tools for MAUI with `Microsoft.Maui.AI.Attributes`. USE FOR: `ExportAIFunction`, `AIToolSource`/`AIToolContext`, `Default.Tools`, DI-bound parameters, AOT-safe tools, `UseFunctionInvocation`. DO NOT USE FOR: Essentials.AI chat/embeddings or native bindings.
- `maui-app-architecture` — Design MAUI app architecture. USE FOR: DI/MauiProgram, MVVM page/ViewModel wiring, Shell routes/GoToAsync/query params, trim-safe `IQueryAttributable`, `x:DataType` compiled bindings, page lifetimes, avoiding service locators. DO NOT USE FOR: resources, API versioning, runtime debug tools.
- `maui-app-assets-lifecycle` — Configure MAUI assets and lifecycle. USE FOR: `MauiIcon`, `MauiSplashScreen`, images, fonts, raw assets, `OpenAppPackageFileAsync`, window lifecycle, `ConfigureLifecycleEvents`, resume/state restore, Xamarin asset migration. DO NOT USE FOR: localization, permissions, broad project structure.
- `maui-apple-design` — Apple's interface-design and fluid-motion approach, translated for .NET MAUI (C#/XAML). USE FOR: gesture-driven UI, spring animations, drag/swipe/sheet interactions, momentum projection, interruptible transitions, translucent materials and depth, Dynamic Type/tracking/leading, reduced-motion, haptics, and the design foundations (feedback, spatial consistency, restraint) behind Apple-style interfaces. DO NOT USE FOR: XAML layout, binding or state bugs, or Shell routes (use maui-ui-patterns), `CollectionView` loading or handler internals (use maui-controls-deep-dive), screen-reader audits (use maui-accessibility), startup/jank measurement, trim or NativeAOT work (use maui-performance), or native services and manifests (use maui-platform-invoke).
- `maui-aspire-client` — Connect MAUI apps to Aspire-hosted APIs. USE FOR: `AddServiceDiscovery`, typed `HttpClient`, `https+http://apiservice`, missing AppHost config on devices, Android emulator `10.0.2.2`, iOS simulator `localhost`, physical-device LAN/dev-tunnel fallbacks, dev certs, Bearer handlers, debug-only cleartext. DO NOT USE FOR: offline caching, OAuth callbacks, or server-side Aspire.
- `maui-auth-secure-storage` — Implement MAUI auth and secure storage. USE FOR: WebAuthenticator/MSAL, OAuth/OIDC redirects, Entra ID, callback URIs, Android intent filters, `CFBundleURLTypes`, token cache cleanup, SecureStorage, logout, Blazor Hybrid auth handoff. DO NOT USE FOR: architecture, API retries/offline data, UI debugging.
- `maui-blazor` — I-Synergy MVVM patterns for .NET MAUI + Blazor Hybrid shells (shared ViewModels, ConfigureServices bootstrapper, BlazorWebView orchestration). Use when wiring a .NET MAUI + Blazor Hybrid shell with shared ViewModels and BlazorWebView orchestration.
- `maui-blazor-hybrid` — Build/debug MAUI Blazor Hybrid. USE FOR: BlazorWebView vs HybridWebView, Razor UI, embedded HTML/JS, `AddMauiBlazorWebView`, root components, JS/.NET messaging, trim-safe JSON, wwwroot assets, auth/data handoff, DevFlow CDP route/DOM debugging. DO NOT USE FOR: pure XAML UI or browser-only apps.
- `maui-controls-deep-dive` — Apply advanced MAUI control guidance. USE FOR: `CollectionView` incremental loading, `RemainingItemsThreshold`, `EmptyView`, `AutomationId`, avoiding `ScrollView` wrappers, .NET 10 `SafeAreaEdges`, `GraphicsView`/`IDrawable`, gestures, animations. DO NOT USE FOR: general layout, full accessibility, profiling, handlers, Apple-style motion and gesture feel (use maui-apple-design).
- `maui-current-apis` — Keep MAUI guidance target-framework-safe. USE FOR: checking TFM, net8 vs net10 API choices, `SafeAreaEdges`, replacing `Application.Current.MainPage`, Xamarin.Forms namespaces, Shell/window APIs, avoiding .NET 10-only APIs on older targets. DO NOT USE FOR: workload discovery, runtime inspection, migration planning.
- `maui-custom-handlers` — Implement or migrate MAUI visual handlers. USE FOR: handler mappers, type guards, unique mapper keys, renderer-to-handler migration, `ConnectHandler`/`DisconnectHandler`, `PropertyMapper`, `CommandMapper`, custom `ViewHandler`, platform partials, `CreatePlatformView`, `ConfigureMauiHandlers`. DO NOT USE FOR: non-visual APIs, full Xamarin migration, native SDK bindings.
- `maui-devflow-debug` — Run DevFlow inspect-and-fix loops for MAUI apps. USE FOR: launch, device selection, agent recovery, broker/port/adb, tree/screenshot, Blazor CDP, and iterative UI debugging. DO NOT USE FOR: first-time setup or non-MAUI automation. INVOKES: DevFlow `maui_*` MCP tools when available; `maui devflow` CLI as fallback; `dotnet`, `adb`, and `simctl` for build, deployment, and connectivity work.
- `maui-devflow-onboard` — Add DevFlow to a MAUI app. USE FOR: package refs, `MauiProgram` registration, Blazor WebView/GTK variants, verification after `maui devflow init`. DO NOT USE FOR: troubleshooting, debugging, UI inspection, or build failures. INVOKES: `maui devflow`, `dotnet`.
- `maui-devflow-session-review` — Review past MAUI DevFlow sessions. USE FOR: DevFlow friction reports, classifying `maui_tap`/`maui_hittest`/`maui_screenshot`/`maui_cdp_webviews` issues vs app bugs, markdown Environment/Findings reports, scrubbed dotnet/maui-labs issue drafts, workaround summaries. Does not run live `maui devflow`. DO NOT USE FOR: fixing bugs, onboarding, live debugging, or memory search.
- `maui-device-capabilities` — Implement MAUI device capabilities with permissions and platform declarations. USE FOR: camera/media/file pickers, durable file copies, geolocation, maps, contacts, Android manifest entries, iOS usage descriptions, runtime permission prompts, denied/cancelled flows. DO NOT USE FOR: notifications, auth, UI layout.
- `maui-essentials-ai` — Adopt `Microsoft.Maui.Essentials.AI` for local/on-device MAUI AI. USE FOR: Apple Intelligence chat, `IChatClient`, iOS/macOS/Mac Catalyst 26+ checks, fallback UI, `NLEmbeddingGenerator`, local tool invocation, privacy/offline UX. DO NOT USE FOR: source-generated tools, cloud-only AI, UI debugging.
- `maui-labs-platform-targeting` — Target MAUI Labs desktop backends from MAUI apps. USE FOR: Linux GTK4 head projects, `maui-linux-gtk4`, `maui-macos`, `maui-wpf`, net10 desktop setup, `UseMauiAppLinuxGtk4`, AppKit vs Mac Catalyst, parity planning. DO NOT USE FOR: backend implementation, handlers, Essentials services.
- `maui-localization-theming` — Implement MAUI localization and theming. USE FOR: RESX/AppResources, runtime culture switching, RTL/FlowDirection, platform language metadata, `AppThemeBinding`, `DynamicResource`, light/dark/system themes, `UserAppTheme`. DO NOT USE FOR: general layout, accessibility audits, icon/splash assets.
- `maui-networking-offline-data` — Build MAUI networking and offline data. USE FOR: typed `HttpClient`, JSON serialization, Android `10.0.2.2`, iOS simulator localhost, LAN/dev-tunnel fallback, debug cleartext, offline-first screens, SQLite/EF Core sync metadata, queues, encryption decisions, retries, cancellation. DO NOT USE FOR: auth redirects, Aspire service discovery, UI layout.
- `maui-notifications-deep-links` — Implement MAUI notifications and deep links. USE FOR: local/push notifications, FCM HTTP v1 migration, APNs/Azure Notification Hubs, permission UX, Android channels/`POST_NOTIFICATIONS`, iOS `UNUserNotificationCenter`, token lifecycle, notification tap navigation, app links/universal links/URI schemes. DO NOT USE FOR: OAuth callbacks, generic Shell navigation, picker/location permissions.
- `maui-performance` — Fix measurable MAUI performance issues. USE FOR: `maui profile startup`, Release/physical-device measurements, janky `CollectionView`, compiled bindings, oversized images, `MauiImage` `BaseSize`, thumbnail decoding, trim/NativeAOT regressions, IL2026, source-generated serializers, linker validation. DO NOT USE FOR: generic UI bugs, workload discovery, architecture-only work, motion and gesture design (use maui-apple-design).
- `maui-platform-invoke` — Add native platform APIs through MAUI services and lifecycle hooks. USE FOR: DI wrappers, permissions, AndroidManifest.xml, Info.plist, entitlements, partial platform files, `ConfigureLifecycleEvents`, choosing services vs handlers vs bindings. DO NOT USE FOR: visual handlers, native SDK bindings, backend.
- `maui-project-structure` — Configure MAUI single-project structure. USE FOR: app icons/splash screens, resource folders, images/fonts/raw assets, app display/build versioning, Central Package Management, platform metadata files, `AndroidManifest.xml`, `Info.plist`, package IDs/app identifiers. DO NOT USE FOR: UI debugging, workload discovery, MVVM/Shell architecture.
- `maui-release-notes` — Turn official .NET/MAUI release notes into an app upgrade plan. USE FOR: breaking-change summaries, Xcode/JDK/Android SDK requirements, global.json/workload/package updates, CI image changes, migration checklists, validation plans, live version lookup. DO NOT USE FOR: authoring workload release notes or marketing copy.
- `maui-specialist` — MAUI mobile development specialist. Use for building cross-platform mobile apps, implementing offline-first architecture, platform-specific features, or data synchronization.
- `maui-ui-patterns` — Fix MAUI UI layout, state, and automation issues. USE FOR: `CollectionView` scrolling, DataTemplate bindings, command bindings, Grid/FlexLayout sizing, binding-driven states, avoiding `ScrollView` parents, stable AutomationIds, `x:DataType`, EmptyView/loading/error states. DO NOT USE FOR: Shell routes, full accessibility, vendor-specific controls, animation and gesture feel (use maui-apple-design).
- `maui-unit-testing` — Add MAUI app tests around ViewModels, services, platform abstractions, and unit/integration/device boundaries. USE FOR: xUnit, avoiding `MauiProgram.CreateMauiApp` in unit tests, fakes/mocks, injectable Essentials interfaces, `PlatformNotSupportedException`, navigation/data services, AppProjectReference, device-test decisions. DO NOT USE FOR: UI automation or profiling.
- `maui-xcode27-migration` — USE FOR Xcode 27 compatibility decisions and migration of existing .NET MAUI iOS/Mac Catalyst apps, INCLUDING partially migrated apps that already have scene manifests/delegates but still use AppDelegate or application-level callbacks. Load BEFORE file discovery; file access is not a prerequisite. Existing scene files do not mean migration is finished. Also use for SDK 27 "UIScene lifecycle is required" or NoSceneLifecycleAdoption startup failures, preserving warm/cold links and quick actions during this upgrade, readiness/no-op audits, read-only .NET 9/.NET 11 compatibility or pinning questions, and Apple 27.0 packs with Xcode 27.1 mismatches. Compatibility audits do not authorize toolchain installation or major upgrades. DO NOT USE FOR Android-only, Windows-only, or no-Apple-head apps; ordinary UI or hinge/layout requests; listing Xcodes; non-MAUI apps; or unrelated auth work, even if Xcode 27 is mentioned.
- `mobile-release` — Publishing .NET MAUI apps to the Apple App Store and Google Play. Use when building AAB/IPA release artifacts, signing, uploading via Google Play / App Store Connect, configuring release pipelines, or debugging store rejections.
- `performance-engineer` — Performance optimization specialist. Use when profiling applications, optimizing database queries, implementing caching, or improving response times.
- `playwright-tester` — Playwright E2E and UI testing specialist. Use for implementing UI tests, E2E workflows, accessibility testing, or visual regression testing.
- `refactor` — Bulk refactor specialist. Use for large-scale find-and-replace transformations, renaming patterns across the entire solution, or systematically migrating from one pattern to another. Trigger whenever the user says "rename X to Y everywhere", "change all X to Y", "migrate from X to Y", or needs to apply a transformation to many files at once — even if they don't use the word "refactor".
- `security` — Security architect and coordinator. Use for overall security strategy, compliance requirements (GDPR, SOC2, HIPAA), threat modeling, or coordinating security across teams.
- `skill-creator` — Create new skills, modify and improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, edit or optimize an existing skill, write test cases, or improve a skill's description for better triggering accuracy. Trigger whenever the user says "create a skill", "make a skill for X", "turn this into a skill", "improve this skill", or wants to capture a workflow as a reusable skill.
- `software-security` — Application security specialist. Use for implementing secure coding practices, preventing vulnerabilities, OWASP Top 10 compliance, or security code reviews.
- `solution-generator` — Generates a complete .NET solution scaffold from an architecture document and design interrogation deliverables. Use after running design-interrogation to translate the architecture document, ubiquitous language, and use cases into a working solution structure with all projects, CQRS handlers, and entity configurations. Trigger whenever the user says "generate the solution", "scaffold the project", "create the solution structure", or wants to turn an architecture document into code.
- `technical-writer` — Documentation specialist. Use when creating XML documentation, API docs, architecture diagrams, README files, or technical documentation.
- `ubiquitous-language` — Captures and maintains the domain vocabulary (ubiquitous language) for a bounded context. Use when building a domain model, running a design interrogation session, or whenever domain terms need to be defined and documented. Trigger whenever the user says "define domain terms", "glossary", "ubiquitous language", or when terms emerge during design sessions. Outputs a structured glossary to UBIQUITOUS_LANGUAGE.md.
- `ui-blazor` — Blazor UI library implementation (View<TViewModel>, ConfigureServices bootstrapper, Fluent UI integration, form-factor + antiforgery services, HTTP resilience). Use when implementing the Blazor UI library's View<TViewModel>, Fluent UI integration, form-factor/antiforgery services, or HTTP resilience.
- `ui-core` — Cross-platform UI abstractions (authentication, token storage, localization, theme + language view models) that every ISynergy shell builds on. Use when building the shared UI abstractions — authentication, token storage, localization, or theme and language view models — that every ISynergy shell relies on.
- `ui-maui` — .NET MAUI implementation of the I-Synergy UI stack: ConfigureServices bootstrapper, cross-platform dialog/navigation/theme/file/camera services, NavigationMenu controls, and dynamic theme system. Use when implementing .NET MAUI dialog/navigation/theme/file/camera services, NavigationMenu controls, or the dynamic theme system.
- `ui-uwp` — UWP implementation of the ISynergy UI stack (Frame navigation, ContentDialog service, adaptive layouts, WinUI 2 controls). Use when implementing UWP Frame navigation, the ContentDialog service, adaptive layouts, or WinUI 2 controls.
- `ui-winui` — WinUI 3 implementation details: Fluent Design shell, ContentDialog service, camera/file integrations, title bar customization, Windows 11 accent sync. Use when implementing a WinUI 3 Fluent Design shell, ContentDialog service, camera/file integration, title bar customization, or Windows 11 accent sync.
- `ui-wpf` — Windows Presentation Foundation (WPF) implementation of the ISynergy UI stack: dialog/navigation services, theme system, BladeView controls, update pipeline. Use when implementing WPF dialog/navigation services, the theme system, BladeView controls, or the update pipeline.
- `unit-tester` — MSTest unit testing specialist. Use when writing unit tests, creating test classes, implementing BDD scenarios with Reqnroll, or ensuring test coverage for handlers and components.
- `update-skills` — Syncs .github/skills/, .github/skills/, and .reasonix/skills/ from .ai/skills/ (the source of truth). Run after adding, editing, or removing a skill in .ai/skills/.
- `upgrade-template` — Upgrades an existing project with improvements from the template. Use when the user says "upgrade the template", "sync template changes to a project", "update project X with new skills", or wants to apply template improvements without losing project-specific context. Runs upgrade-template.py which copies new files and diffs changed ones, never touching project-owned paths.
- `usecase-specification` — Drafts and finalizes use case specifications for bounded contexts. Use when a bounded context's main flow becomes clear during design sessions, or to extract use cases from existing documents. Trigger whenever the user says "use case", "user flow", "system interaction", or asks to document what the system does. Outputs structured specifications with main flow, alternate flows, and Gherkin scenarios to docs/bounded-contexts/{Domain}/use-cases.md.
- `user-story` — Drafts and finalizes user stories with Gherkin acceptance criteria for bounded contexts. Use when acceptance criteria for a feature are agreed during design sessions, or to extract stories from existing documents. Trigger whenever the user says "user story", "as a user", "acceptance criteria", or asks to define what a feature needs to do. Validates stories against INVEST criteria. Outputs structured stories with Gherkin to docs/bounded-contexts/{Domain}/user-stories.md.
- `verify-config` — Audits AGENTS.md and .ai/ reference files against actual codebase patterns and hard requirements. Use to detect configuration drift and ensure documentation stays in sync. Use when you need to verify AGENTS.md and .ai/ references still match the codebase, or to compute the standards compatibility manifest.
- `vertical-slices` — Translates use cases and user stories into vertical slice blueprint JSON for feature-by-feature implementation. Use after solution-generator to plan each feature as a self-contained vertical slice spanning all layers. Trigger whenever the user says "vertical slice", "feature blueprint", "implement feature by feature", or wants to break down user stories into implementable slices.
- `winui-specialist` — WinUI 3 / Windows App SDK development specialist. Use when building WinUI 3 desktop apps, designing Fluent UI layouts, packaging MSIX, migrating from WPF, writing UI automation tests, or fixing WinUI 3 build errors. Covers the full inner loop: scaffold → design → build → run → test → package.
- `xamarin-forms-migration` — Plan Xamarin.Forms to MAUI migrations. USE FOR: audits, fresh `dotnet new maui`, namespace updates, `DependencyService` to DI, `MessagingCenter` replacement, renderer triage, `MauiProgram`, permissions, parity planning. DO NOT USE FOR: brand-new MAUI apps, native SDK bindings, backend.
- `xaml-theme-generator` — Generate XAML ResourceDictionary theme files (WinUI, UWP, MAUI) from a single accent color. Trigger when the user provides an accent color for a XAML app, says "generate a XAML theme", "create WinUI theme resources", "update MAUI colors", "generate App.xaml theme", or asks to theme their WinUI/UWP/MAUI application. Handles both hsl(H, S%, L%) and

### Agents
- `architect` — Solution architecture and system design — designs features, chooses patterns, defines component boundaries, and produces implementation blueprints. Use for feature design, pattern selection, component boundaries, and architecture analysis.
- `designer` — Visual/graphical design — color palettes, typography, spacing, branding, iconography, accessibility contrast, and visual hierarchy. Use for visual design — color palettes, typography, branding, design tokens, and accessibility contrast.
- `developer` — .NET/C# code implementation — writes CQRS handlers, API endpoints, Blazor components, EF Core data access. Use for all .NET code changes including refactoring, builds, and verification.
- `reviewer` — Code quality and architecture review specialist — reviews for SOLID principles, CQRS patterns, security issues, and architecture compliance. Use for code quality, SOLID, CQRS compliance, security review, architecture audit, and ISO/IEC 25010 finding attribution.
- `security` — Security reviewer and blast-radius analyst — reviews authentication, authorization, secrets handling, data exposure, and dependency risk, and reports severity-ranked findings without editing code. Use for blast-radius and exposure analysis, threat modelling, OWASP review, and dependency and secret audits.
- `tester` — Unit and integration test specialist — writes MSTest tests, Moq mocks, Reqnroll BDD scenarios. Use for MSTest/Reqnroll test design, BDD scenarios, and integration test strategy.
- `ui-developer` — Frontend UI development — builds Blazor components, MAUI pages, layouts, CSS/styling, and UX patterns. Use for Blazor/MAUI components, layouts, CSS/styling, and UX patterns.
- `ui-tester` — Playwright E2E testing specialist — writes UI tests, accessibility checks, visual regression tests. Use for Playwright E2E tests, accessibility checks, and visual regression.
- `writer` — Documentation specialist — writes XML documentation, API docs, README files, architecture decision records, and technical documentation. Use for XML docs, READMEs, ADRs, and technical prose.

<!-- ai-workspace-manager:installed:end -->

<!-- ai-workspace-manager:copilot-reference:start -->
## Project Context

**NuGet Package Manager** is a Visual Studio Code extension for browsing, installing, updating and
auditing NuGet packages across .NET projects. It is a **dual-language repository**:

- **.NET / C# core** — `src/NugetPackageManager.Core`, `.Core.NuGet` and `.Core.Workspace`
  (`NugetPackageManager.slnx`), published to `dist/core` and run as a sidecar process. It owns the
  NuGet source client, the project model, CPM resolution, dependency operations and toolchain
  detection.
- **TypeScript / Node.js extension** — `src/NugetPackageManager.VSCode.Common`, `.VSCode.Host` and
  `.VSCode.Webview`. It owns VS Code activation, the typed RPC layer and the Lit webview.

Neither half is legacy: a change to the sidecar contract crosses C#, `HostAPI` and the webview.

See `AGENTS.md` for the canonical agent guide and `.ai/project/` for architecture, technology and
preferences. `CLAUDE.md` retains the detailed engineering guide.

## Architecture

Three runtime contexts, two of them in the extension process:

```
VS Code Extension Host (Node.js)         Webview (Browser / Lit components)
  src/NugetPackageManager.VSCode.Host/extension.ts
  src/NugetPackageManager.VSCode.Host/host-api.ts  <-- RPC -->  src/NugetPackageManager.VSCode.Webview/main.ts
  src/NugetPackageManager.VSCode.Common/rpc/rpc-host.ts         src/NugetPackageManager.VSCode.Common/rpc/rpc-client.ts
        │
        │ sidecar JSON-RPC over stdio (nuget/core-process.ts, nuget/core-client.ts)
        ▼
.NET core (dist/core) — src/NugetPackageManager.Core* projects
```

All host ↔ webview communication goes through a typed RPC layer defined in
`src/NugetPackageManager.VSCode.Common/rpc/types.ts`. Every RPC method returns `Result<T>` — a
discriminated union `{ ok: true, value: T } | { ok: false, error: string }`.
<!-- ai-workspace-manager:copilot-reference:end -->
