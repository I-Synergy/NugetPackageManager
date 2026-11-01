---
name: design-interrogation
description: >
  Structured design interrogation — interview the user relentlessly about a plan,
  architecture, or technical decision until every branch of the decision tree is
  resolved. Consumes product-discovery output when available. Use whenever a user says "grill me", "stress-test my plan", "poke holes
  in this", "challenge my design", "interview me about this design", or wants a
  rigorous review of any design, architecture, or technical proposal — even if they
  don't use these exact words. Use when a plan, architecture, or technical decision needs pressure-testing before you commit to it. When in doubt, trigger this skill.
---

# Design Interrogation

Relentless, structured interrogation of a plan or design. Walk every branch of the
decision tree, resolve dependencies between decisions one-by-one, and reach a shared
understanding before closing.

## Upstream: product-discovery

This skill consumes the output of [`product-discovery`](../product-discovery/SKILL.md) when available.
If the user ran `product-discovery` first, Phase -1 recognises `docs/product/*` files and imports
all pre-resolved decisions (`PD-nnn` entries from `discovery-decisions.md`) with a **Source** column
in `session-decisions.md`, so interrogation focuses only on the remaining technical dimensions.
When discovery did NOT run, Phase -1 offers a short capture pass for A1, A2, and A5 based on
existing documents to draft Product Specification sections 1–3, then proceeds to full interrogation.

---

## What This Skill Does

- **Interviews** the user on every aspect of their plan, one focused question at a time
- **Maps** the decision tree, tracking which branches are resolved, deferred, or blocked
- **Recommends** a concrete answer with reasoning for each question asked
- **Explores** the codebase to answer questions that can be resolved without user input
- **Summarizes** all decisions and open items when interrogation is complete

---

## Interrogation Protocol

### Session Start — Load Required Skills

Before asking the first question, load these three skills. They are active throughout the
entire session — not just at the end:

| Skill | Load | Role During Session |
|-------|------|---------------------|
| [`ubiquitous-language`](../ubiquitous-language/SKILL.md) | **Required — load first** | Captures domain terms as they emerge; draft written to `UBIQUITOUS_LANGUAGE.md` immediately |
| [`usecase-specification`](../usecase-specification/SKILL.md) | **Required — load second** | Drafts use cases as flows resolve; each bounded context gets a draft file |
| [`user-story`](../user-story/SKILL.md) | **Required — load third** | Drafts stories as acceptance criteria are agreed; finalized with Gherkin at session end |

Then create the decision log (see **Progressive Document Capture** below) and start Phase -1.

---

### Phase -1: Document Intake

#### Session Start: Check for interrupted session first

On start, detect if `docs/session-decisions.md` exists. If it does:

> I found an earlier session. Would you like to **resume** it, **amend** (change some decisions), or **start over**?

- **Resume**: reload decisions from the earlier session and continue with open items
- **Amend**: show which decisions to revise, replay those branches
- **Start over**: begin fresh (archive the earlier file)

#### Check for product-discovery output

If the user ran [`product-discovery`](../product-discovery/SKILL.md) first, `docs/product/` will
contain `product-brief.md`, `audience-profile.md`, `ux-brief.md`, `ui-design-brief.md`,
`platform-deliverables.md`, and `discovery-decisions.md`. When present:

1. Read all files in `docs/product/` — do NOT ask questions already answered there
2. Import each `PD-nnn` decision from `discovery-decisions.md` to `session-decisions.md` as **Pre-Resolved**,
   with a **Source** column showing `docs/product/discovery-decisions.md`
3. Pre-resolve Phase 0: **A1** (product type from discovery), **A2** (scope from product-brief), **A5** (surfaces from platform-deliverables)
4. Pre-fill **A4** (Hard Constraints) from discovery Phase 13/14 constraints and the codebase, but **ask for confirmation**
5. **Always ask A3** (Architecture Shape) — discovery does not resolve this
6. Flag any `[TECH-OPEN]` items in discovery decisions as open questions for the matching dimension
7. Proceed directly to Phase 0 (A3 + confirmed A4) with the product context loaded

#### Otherwise: Check for other existing documents

> Before we start: do you have any existing documents I should read first?
> (business case, PRD, architecture spec, migration plan, functional design)
> If so, share them — I'll save them to `docs/input/` and extract what's already decided.
>
> **Note:** Input files may hold customer data or commercial secrets. I'll confirm the repository
> is private before saving; if you'd like to keep them out of version control, I can add
> `docs/input/` to `.gitignore`.

If documents are provided:
1. Save them to `docs/input/` (e.g. `docs/input/business-case.md`) and confirm repository visibility
2. Read and analyze them — identify any bounded contexts already named
3. Extract all decisions already made — log to `session-decisions.md` as **Pre-Resolved** with Source noted
4. Run extractions **in parallel** using the skills below:
   - If BCs already identifiable → spawn one extractor per BC
   - If BCs not yet known → run both skills in parallel
   - → [`usecase-specification/SKILL.md` — Mode 0](../usecase-specification/SKILL.md) for use cases
   - → [`user-story/SKILL.md` — Mode 0](../user-story/SKILL.md) for user stories
5. Announce: "Extracted [N] use cases and [M] user stories — [X] gaps marked [OPEN]."
6. Proceed to Phase 0

If no documents and no earlier session → proceed directly to Phase 0.

---

### Phase 0: Strategic Anchor

Before starting depth-first interrogation, establish the business context and architecture shape.
If product-discovery ran, A1, A2, and A5 are pre-resolved; otherwise ask all five (A1–A5).
Always ask A3 and confirm A4 regardless of discovery history.

**When discovery ran:** Present A3 + confirmed A4 only. When discovery did NOT run:
present all five at once, clearly numbered A1–A5:

---

**A1 — Business Case** *(Pre-resolved if discovery ran)*

Is this greenfield (new system), migration (replacing an existing system), or
an extension of an existing system?

**My recommendation:** [infer from context; or from discovery product-type]

---

**A2 — Purpose & Scope** *(Pre-resolved if discovery ran)*

What are we building and what is explicitly out of scope?

**My recommendation:** [scoped interpretation; or from discovery product-brief]

---

**A3 — Architecture Shape** *(Always ask)*

Event-driven with event sourcing, event-driven with state-based persistence,
or direct request/response?

**My recommendation:** [based on domain complexity and existing stack]

---

**A4 — Hard Constraints** *(Confirm if pre-filled; ask if no discovery)*

What is non-negotiable? (team size, deadline, existing stack, compliance,
cloud vs. on-premise)

**My recommendation:** [from discovery Phase 13/14 if available; else infer from codebase
— check `Directory.Packages.props` and Aspire AppHost for existing choices]

---

**A5 — Surfaces & Deliverables** *(Pre-resolved if discovery ran)*

What are the target platforms and surfaces? (web, iOS, Android, Windows, macOS, API, etc.)

**My recommendation:** [from `platform-deliverables.md` if discovery ran; else
infer from the problem domain and audience]

---

After A1–A5 are answered or confirmed, if product-discovery ran, propose bounded context candidates derived from the MoSCoW capabilities, top journeys, and glossary from `discovery-decisions.md`. Ask:

> Based on the capabilities and journeys you described, I see these candidate bounded contexts: [names from discovery]. Do these match your mental model, or should we rename or split them?

Confirm the list before proceeding to Phase 1. This confirms the BC count and enables the Phase 1 parallel trigger.

Then adapt the interrogation order based on A1. See **Interrogation order** table below for the sequence per product type.

---

### Phase 1: Parallel BC Interrogation

When Phase 0 (A2) identifies 2 or more bounded contexts, spawn one sub-agent per BC
and run them in parallel. Each agent covers Dimensions 2–7 for its BC only. Dimension 8 (Migration & Rollout) is global and runs as a single-agent dimension after the domain block; then Dimensions 9–15 follow in dependency order.

**Trigger:**
```
BCs identified in A2 ≥ 2?
  YES → Spawn N BC agents in parallel (one per BC)
  NO  → Continue single-agent depth-first from Phase 0
```

**Per-BC dimensions (Dimensions 2–7):**

| Dimension | BC-specific questions |
|-----------|----------------------|
| 2 — Domain Model | Aggregates, entities, value objects for this BC |
| 3 — BC Internals | Scope boundary — what is inside this BC? |
| 4 — Data Flow | Commands, queries, events flowing through this BC |
| 5 — Integration Points | Which external systems does this BC touch? |
| 6 — Failure Modes | What happens when this BC's core component fails? |

Each BC agent writes immediately to:
- `session-decisions.md` — its own BC section
- `docs/bounded-contexts/{Domain}/use-cases.md` — draft use cases as flows resolve
- `docs/bounded-contexts/{Domain}/user-stories.md` — draft stories as criteria are agreed
- Follows the depth-first rule within its own BC

**Coordination agent** (main session) batches one open question per BC per round:

```
**BC: OrderManagement — Question 1 — Domain Model**
[question + recommendation]

**BC: Inventory — Question 1 — Domain Model**
[question + recommendation]
```

**After all BC agents complete:**
1. Cross-BC integration questions (how do BCs communicate?)
2. Dimension 8 — Migration & Rollout (global, single agent)
3. Dimensions 9–15 in dependency order (see **Interrogation order** table)

---

### Question Format

Ask one question at a time. Each question must be specific, answerable, and accompanied
by a concrete recommendation. Use this format:

---

**Question N — [Topic]**

[The question, clearly stated.]

**My recommendation:** [Your concrete recommendation and the reasoning behind it.]

---

Do not list multiple questions at once. Depth-first: fully resolve one branch before
moving to the next sibling.

### Decision Dimensions

Cover these areas in dependency order — skip dimensions that are clearly irrelevant
or already resolved. Dimensions 1–8 are ordered for backend/domain work; Dimensions 9–15
cover client surfaces, operations, and quality gates (see **Interrogation order** table below).

| # | Dimension | Key Questions |
|---|-----------|---------------|
| 1 | **Purpose & Scope** | What is being built? What is explicitly out of scope? |
| 2 | **Domain Model** | What are the aggregates, entities, and value objects? |
| 3 | **Bounded Contexts** | Where are domain boundaries? How do contexts communicate? |
| 4 | **Data Flow** | How do commands, queries, and events move through the system? |
| 5 | **Integration Points** | What external systems, APIs, or services are involved? |
| 6 | **Failure Modes** | What happens when each component fails? |
| 7 | **Non-Functionals** | Which quality attributes must this solution meet? — question set below |
| 8 | **Migration & Rollout** | How is this deployed? What is the rollout strategy? |
| 9 | **Client Surfaces & UX Architecture** | Per surface from A5: render/host model (Blazor Server/WASM/Auto/Hybrid/MAUI/WinUI/WPF), shared UI library vs per-platform, navigation & state management, design-system/tokens implementation, theming (light/dark/high-contrast), responsive & adaptive rules, offline & sync conflict policy, device-API access, localisation mechanism, accessibility implementation & test approach, form-factor handling. **Prototype fidelity:** token source of truth, component mapping, visual-regression baseline from mockups, design review gate |
| 10 | **Identity, Access & Tenancy** | Identity provider, flows per surface, roles & permissions, tenancy model & isolation, session/token lifetime per platform, admin/impersonation, API client auth |
| 11 | **Data Management & Privacy** | Stores per bounded context, retention & deletion, PII inventory & classification, consent, backup/restore & RPO/RTO, import/migration, export/portability, data residency |
| 12 | **Delivery, Environments & Hosting** | Environments, CI/CD, branching & versioning, hosting/cloud & cost envelope, store/installer/updater pipelines, feature flags, rollback, signing & secrets. **Sizing:** end this dimension by asking: *"What is the T-shirt size (XS/S/M/L/XL) for each capability? Does this fit your budget and deadline?"* Log the answer and compare scope vs budget in the Product Specification. |
| 13 | **Observability & Operations** | Structured logging, metrics, tracing, alerting thresholds, product analytics tracking plan & consent, crash reporting for native clients, support workflow, runbooks, SLA/SLO |
| 14 | **Testing Strategy** | Test pyramid per BC, BDD scope, E2E & accessibility & visual regression (against the mockups), device/browser/OS matrix, test data, performance tests, definition of done. **Sizing confirmation:** end by confirming the sizing question answers from Dimension 12 against the testing strategy — does the test pyramid fit the estimate and deadline? |
| 15 | **AI/ML Features** *(conditional)* | Asked only when discovery flags AI or the user mentions it: model/provider choice & swap-ability, prompt/data handling & privacy, evaluation & quality gates, human-in-the-loop, cost & rate limits, safety/abuse controls, transparency, EU AI Act classification |

### Interrogation order

Dimensions are resolved in dependency order (domain first; migration immediately after when A1=Migration; then quality first; identity and data before client surfaces; delivery, operations and testing last). The sequence below applies to **greenfield** and **extension** products. For **Migration**, Dimension 8 is pulled forward to immediately after the domain block (Dimensions 1–7).

| Position | Dimension | Why |
|----------|-----------|-----|
| 1 | 1–7 (Domain + Quality) | Core design decisions; shape all downstream choices |
| 2 | 8 (Migration & Rollout) *(greenfield/extension: moved here for migrations)* | If A1=Migration, immediately after domain; otherwise final dimension |
| 3 | 11 (Data Management) | Determine storage and retention before designing surfaces |
| 4 | 10 (Identity & Access) | Auth flow shapes client surface design |
| 5 | 9 (Client Surfaces) | Navigate by audience, tech stack, data decisions already made |
| 6 | 12 (Delivery & Hosting) | Constraints from hosting/CI/CD affect client and server choices |
| 7 | 13 (Observability) | Measurement plan (tracking) seeds from goals (GL-nnn) |
| 8 | 14 (Testing) | QA strategy last; scope set by all prior dimensions |
| 9 | 15 (AI/ML) | Conditional; only when flagged by discovery or the user |

**A1 branching — override this order when A1 ≠ Greenfield:**
- **Greenfield:** Use order above (1–7 → 11 → 10 → 9 → 12 → 13 → 14 → 15); Dimension 8 is final
- **Migration:** Execute Dimension 8 immediately after Dimension 7 (right after domain block); then 11 → 10 → 9 → 12 → 13 → 14 → 15
- **Extension:** Run codebase-first checks before Phase 0 (what already exists, what is pre-resolved); most decisions 2–7 are confirmed from existing code, not asked

### Dimension 7 — Quality Attribute Questions

Dimension 7 is where quality attributes **enter** the design — the reviewer only inspects them after
the fact. The vocabulary is ISO/IEC 25010:2023: the nine product quality characteristics and their
review questions are in `.ai/reference/quality-model.md`. Resolve these with the user in the standard
question format, one at a time, and ask only the ones the design implicates. An attribute that does
not apply is recorded as **not applicable** and is not turned into a question — most solutions resolve
three to five of the nine, and asking all nine as a matter of course turns a design conversation into
a questionnaire.

| # | Characteristic | What to resolve |
|---|---|---|
| 1 | Functional suitability | Which stated business outcome has no use case yet, and which use case has no acceptance criterion behind it? |
| 2 | Performance efficiency | What is the expected load, and what is the slowest acceptable response for the heaviest operation — as a number, not as "fast"? |
| 3 | Compatibility | Which external systems must this exchange data with, in what shape (API version, file format, database dialect), and what must keep running unchanged alongside it? |
| 4 | Interaction capability | Who uses it, through which surface, and how do they find out what to do and recover from a mistake? *No human surface → not applicable.* **If product-discovery ran, this is pre-resolved from `ux-brief.md` / `audience-profile.md` — do not re-ask; log the finding as Pre-Resolved and move on.** |
| 5 | Reliability | Which failures are tolerable and which are not, and what happens to in-flight work when a dependency is down? Is running the same command twice safe? |
| 6 | Security | Who must not be able to do or see this, where does the trust boundary sit, and what data classification applies? |
| 7 | Maintainability | Which parts are expected to change fastest, and which bounded contexts must stay independently changeable? |
| 8 | Flexibility | What must be replaceable without a rewrite (database, identity provider, hosting model), and what must scale on its own? |
| 9 | Safety | Can a wrong answer or an outage here harm a person, a physical system, or data that cannot be recreated — and does the design fail safe? *Ask once; record the answer either way.* |

**Where the answers land.** Each resolved attribute is logged as a Dimension 7 row in
`session-decisions.md` and carried into the architecture document with the rest of the decisions.
Quality attributes are **not** numbered as acceptance criteria — `.ai/reference/traceability.md`
records that rule, and a criterion with no scenario behind it would be reported by the traceability
validator.

### Codebase Exploration

Before asking the user about something that can be determined from the codebase,
explore the codebase first. Announce what you found:

> I checked the codebase and found that X is already handled by Y — moving on.

Use the Read, Grep, and Glob tools to inspect relevant files. Do not ask the user
to confirm what the code already tells you.

### Decision Tree Tracking

Maintain a mental model of the decision tree during interrogation:

- **Open** — decision not yet reached
- **Resolved** — decision made, no open sub-questions
- **Deferred** — user consciously chose to decide later
- **Blocked** — cannot proceed without external information

When a decision opens new sub-questions (e.g., choosing an event-driven approach
raises questions about the event schema), explore those sub-questions before moving
to the next top-level topic.

---

## Progressive Document Capture

Do not wait until the end of the session to write output. Capture decisions, domain terms, use
cases, and user stories **as they emerge** — this ensures nothing is lost if the session is
interrupted, and makes the finalization step a completion pass rather than a cold generation from memory.

### Session Start — Create Decision Log

Before asking the first question, create the decision log file:

```
docs/session-decisions.md
```

Use this header. Include a **Source** column for decisions imported from `docs/product/`:

```markdown
# Session Decisions — {SolutionName}

> Live decision log. Updated after each resolved question. Finalized into the full architecture document at session end.

## Decisions

| # | Dimension | Decision | Rationale | Source |
|---|-----------|----------|-----------|--------|
```

When importing decisions from `docs/product/discovery-decisions.md`, populate the Source
column with the file path and decision ID (e.g., `docs/product/discovery-decisions.md — PD-015`).
When a decision meets a council trigger from `AGENTS.md`, flag it in the Rationale column:
`Council recommended — [trigger name]`.

### After Each Resolved Question

Immediately append to `session-decisions.md`:

```markdown
| {N} | {Dimension} | {chosen approach} | {brief rationale} | |
```

Announce:

> 📝 Logged to `session-decisions.md`.

### When a Domain Term Emerges

As soon as a term is used and agreed upon, append it to `UBIQUITOUS_LANGUAGE.md` (create the
file if it does not yet exist, mark it `[DRAFT]` in the title until the full ubiquitous-language
skill finalizes it):

```markdown
## [DRAFT] Ubiquitous Language — {SolutionName}

| Term | Definition | Bounded Context | Notes |
|------|-----------|-----------------|-------|
| {Term} | {Definition} | {Domain} | [DRAFT] |
```

### When a Use Case Becomes Clear

As soon as the main flow of a bounded context resolves, use `usecase-specification`
skill **Mode 1** to write the draft entry to
`docs/bounded-contexts/{BoundedContext}/use-cases.md`.

→ Follow the draft entry format defined in
  [`usecase-specification/SKILL.md` — Mode 1](../usecase-specification/SKILL.md).
  Do NOT use a custom format here.

### When User Stories Emerge

As soon as acceptance criteria for a feature are agreed, use `user-story`
skill **Mode 1** to write the draft entry to
`docs/bounded-contexts/{BoundedContext}/user-stories.md`.

→ Follow the draft entry format defined in
  [`user-story/SKILL.md` — Mode 1](../user-story/SKILL.md).
  Do NOT use a custom format here.

### Finalization: Complete the Session Deliverables

When interrogation is complete, finalization does not generate from scratch — it **completes and
finalizes** the drafts already written:

- Remove all `[DRAFT]` markers
- Fill gaps in use cases (alternate flows, Gherkin)
- Add Gherkin to user stories, validate INVEST
- Complete the architecture document from `session-decisions.md`

---

## Architecture Document

### Step 1: Load Relevant Instruction Files

Before writing the architecture document, load these instruction files to pre-fill constraints and check for compliance:

| File | Purpose |
|------|---------|
| `.ai/project/tech-stack.md` | Confirm technology choices, versions, and constraints |
| `.ai/reference/forbidden-tech.md` | Check that chosen libraries/patterns are not banned |
| `.ai/project/architecture.md` | Reference architecture patterns and ADR template |
| `.ai/reference/quality-model.md` | ISO/IEC 25010 vocabulary for Dimension 7 answers |
| `.ai/reference/standards.md` | Compliance requirements and validator rules |

Before asking any question, check the codebase for existing choices in `Directory.Packages.props`,
Aspire AppHost, and existing projects — pre-populate A4 constraints and A5 surfaces with what
you find.

### Step 2: Check for Violations

Scan the draft architecture document for these **FORBIDDEN patterns**:

| ❌ Forbidden | ✅ Replace With |
|-------------|----------------|
| SQL DDL (`CREATE TABLE`, `ALTER TABLE`) | EF Core `IEntityTypeConfiguration<T>` |
| Hardcoded connection strings | Aspire `.WithReference()` or environment variables |
| MediatR (`_mediator.Send()`, `services.AddMediatR()`) | Direct `ICommandHandler<T,R>` injection |
| `DateTime` (timezone-naive) | `DateTimeOffset` |
| Missing pattern rationale | Add ADR explaining why the pattern was chosen |

### Step 3: Document Pattern Rationale

For each major pattern, include a brief ADR explaining **why** this implementation was chosen.
Refer to `.ai/project/architecture.md` for the ADR template.

### Step 4: Finalize Session Deliverables (MANDATORY)

The three required skills were loaded at session start and have been capturing drafts throughout
the interrogation. This step **finalizes** those drafts and compiles the Product Specification — it is not a cold generation from memory.

| # | Deliverable | Skill | Output File | Action |
|---|-------------|-------|-------------|--------|
| 1 | **Ubiquitous Language Glossary** | [`ubiquitous-language`](../ubiquitous-language/SKILL.md) | `UBIQUITOUS_LANGUAGE.md` | Complete draft — remove `[DRAFT]`, resolve ambiguities, add missing terms |
| 2 | **Use Case Specifications** | [`usecase-specification`](../usecase-specification/SKILL.md) | `docs/bounded-contexts/{Domain}/use-cases.md` | Complete draft — fill alternate flows, add Gherkin for every flow |
| 3 | **User Stories** | [`user-story`](../user-story/SKILL.md) | `docs/bounded-contexts/{Domain}/user-stories.md` | Complete draft — add Gherkin, validate INVEST, ensure ≥3 criteria per story |
| 4 | **Product Specification** | None (compilation) | `docs/product/product-specification.md` | Compile from deliverables 1–3, session-decisions, architecture document, and `docs/product/*` files (if product-discovery ran) — see **Deliverable 4** subsection below |

#### Finalization Order

Execute in this sequence — each builds on the previous:

1. **Ubiquitous Language first** — finalize all draft terms; canonical vocabulary must be locked
   before use cases and stories are completed.

2. **Use Case Specifications second** — complete all draft use cases using finalized terminology.
   Add Gherkin for every main and alternate flow.

3. **User Stories third** — complete all draft stories using finalized terminology and use cases.
   Add Gherkin traced to every acceptance criterion. Validate INVEST.

4. **Product Specification last** — compile the consolidated what-we-build + technical requirements document; see subsection below for structure.

#### Announcements

For each deliverable, announce what is being finalized and confirm completion. For example:

> **Deliverable 1 of 4 — Ubiquitous Language**
> ✅ Complete — N terms defined.

> **Deliverable 4 of 4 — Product Specification**
> ✅ Complete — specification ready for handoff.

#### Skip Only With Explicit User Consent

If the user says "skip use cases" or "no stories needed", mark the deliverable as **Deferred**
and include it in the closing summary. Never skip without recording it there.

#### Deliverable 4 — Product Specification

The Product Specification is a consolidated index document — written after deliverables 1–3 are complete.
It joins what you are building (from product-discovery, if it ran) with the technical requirements (from this interrogation).

**Structure:** 11 sections — Vision/Problem/Audience → Scope/Release Plan → Experience/Journeys → Surfaces/Deliverables → Domain/Glossary → Technical Requirements → Compliance → Roadmap & Sizing → Traceability → Risks/Assumptions → Sign-Off

**Source map (per-section origin):**
- Sections 1–3 (What we build, Scope, Experience): from `product-brief.md`, `ux-brief.md`, `ui-design-brief.md`, prototype if discovery ran; else capture from A1, A2, A5 and goals (GL-nnn) + skip as [Deferred — run product-discovery]
- Section 4 (Surfaces & Deliverables): from `platform-deliverables.md` if discovery ran; else from A5 + interrogation answers
- Section 5 (Domain, Glossary): from deliverables 1–3 (UBIQUITOUS_LANGUAGE.md, use-cases.md, user-stories.md)
- Section 6 (Technical Requirements): from architecture document + Dimensions 9–15 decisions in `session-decisions.md`
- Sections 7–11: compiled from compliance answers, roadmap sizing, traceability coverage, risks/assumptions, sign-off
- Per-section source tables for sections 7–11 documenting which dimension/decision each requirement came from

**Rules:**
- Skip only with explicit consent; record as **Deferred** in closing summary
- All IDs traced verbatim: `SCR-001`, `UC-{BC}-001`, `US-{BC}-001`, `DLV-001`
- Hyperlink all sections to source documents where they exist

→ Copy and complete: [references/product-specification-template.md](references/product-specification-template.md)

**When discovery did NOT run:**
- Mark Sections 1–3 as [Deferred — run product-discovery], OR
- Run a short capture pass (A1, A2, A5 answers + goals from Dimension 1) to draft Sections 1–3 now
- Section 4 (Surfaces & Deliverables) is always populated from A5
- State which approach is taken in the closing summary

### Step 5: Solution Generation and Design Hand-off

**Recommended pipeline execution sequence:**

1. If product-discovery ran: extract theme tokens from `docs/product/ui-design-brief.md`
2. Run [`css-theme-generator`](../css-theme-generator/SKILL.md) (or `blazor-` / `xaml-theme-generator`), passing the accent colour
3. Run **designer** to refine component usage and design-system (Dimension 9)
4. Run **ui-developer** and **maui-apple-design** for platform-specific surfaces
5. Run [`solution-generator`](../solution-generator/SKILL.md) — pass architecture document and Product Specification as input
6. Translate each user story to [`vertical-slices`](../vertical-slices/SKILL.md) blueprint JSON (feature-by-feature)
7. Run [`playwright-tester`](../playwright-tester/SKILL.md) — consume the prototype as UI acceptance baseline
8. Run [`gap-review`](../gap-review/SKILL.md) — mandatory after generation; validates against design decisions and prototype fidelity

**Key deliverables consumed:**
- `docs/product/product-specification.md` — overall product scope and technical requirements (Deliverable 4)
- `docs/architecture/{SolutionName}-architecture.md` — architecture decisions and ADRs
- `UBIQUITOUS_LANGUAGE.md`, use-cases.md, user-stories.md — domain model and acceptance criteria
- Dimension 9 (Client Surfaces) + A5 — render mode, shared UI, design system — input to theme generators
- Prototype — visual-regression baseline, component mapping reference, design review gate

---

## Closing Summary

When all branches are Resolved or Deferred, present a structured summary:

```
## Interrogation Summary

### Decisions Made
- [Topic]: [chosen approach and brief rationale]

### Council-Flagged Decisions
When a decision met a council trigger, list it here (marked in `session-decisions.md` Rationale column as `Council recommended — [trigger name]`):
- [Decision]: [trigger name] — flagged for council review before implementation

### Deferred Decisions
- [Topic]: Deferred because [reason]

### Remaining Open Questions
- [Any unknowns that require external input]

### Traceability Coverage
- Goals covered by use cases: [N] of [M]; uncovered: [list]
- Acceptance criteria mapped to capabilities: [percentage]
- Architecture decisions linked from Dimensions 1–15: [count]

### Session Deliverables
| Deliverable | Status | File |
|-------------|--------|------|
| Architecture Document | ✅ Complete | `docs/architecture/{SolutionName}-architecture.md` |
| Ubiquitous Language | ✅ Complete / ⏸️ Deferred | `UBIQUITOUS_LANGUAGE.md` |
| Use Case Specifications | ✅ Complete / ⏸️ Deferred | `docs/bounded-contexts/{Domain}/use-cases.md` |
| User Stories | ✅ Complete / ⏸️ Deferred | `docs/bounded-contexts/{Domain}/user-stories.md` |
| **Product Specification** | ✅ Complete / ⏸️ Deferred | `docs/product/product-specification.md` |

### Next Steps (See Step 5)
Follow the **pipeline execution sequence** in Step 5 above: theme generators → designer → solution-generator → vertical-slices → gap-review
```

---

## Example Exchange

**User:** grill me on my new notification service

**Claude:**

---

**Question 1 — Delivery Channels**

Which notification channels must the service support at launch — email only, or
also SMS, push notifications, or in-app?

**My recommendation:** Start with email and in-app. SMS adds third-party costs and
compliance complexity (GDPR/TCPA). Push requires device registration infrastructure.
Both can be added in v2 once the channel abstraction is validated.

---

After the user answers, follow the dependency tree. If the user says
"email and in-app", the next question targets the email provider decision — not
an unrelated topic.

---

## Related Skills

| Skill | When to Load |
|-------|-------------|
| [`product-discovery`](../product-discovery/SKILL.md) | **Upstream** — when the user needs a product interview *before* architecture decisions. Produces pre-resolved input for this skill. |
| [`architect`](../architect/SKILL.md) | Architectural decisions need to be formalized beyond the architecture document |
| [`solution-generator`](../solution-generator/SKILL.md) | After interrogation — scaffold the solution |
| [`vertical-slices`](../vertical-slices/SKILL.md) | Translate stories to implementation blueprints |
| [`gap-review`](../gap-review/SKILL.md) | Validate the generated solution |
| **designer** | Refine design-system decisions and component usage (Dimension 9) |
| **ui-developer** | Build out client surfaces from approved mockups and Dimension 9 decisions |
| **ui-tester** | Validate client surfaces against the prototype baseline |
| **playwright-tester** | Test E2E workflows against the prototype baseline |
