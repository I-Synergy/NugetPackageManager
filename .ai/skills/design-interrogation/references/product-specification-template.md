# Product Specification Template

Copy this skeleton and complete all sections. Use placeholders in square brackets `[like this]` for field values.

---

# Product Specification — {ProductName}

**Status:** Draft / Confirmed
**Respondents:** {list}
**Last updated:** {date}

## 1. What We Are Building

### Vision
[1-2 sentences describing the vision]

### Problem
[Problem statement; who has it; current workaround; cost of not solving]

### Audience Segments
- [Primary segment]: [size], [key characteristics]
- [Secondary segment]: [size], [key characteristics]

### Personas
- [Persona name]: [role], [motivation], [context]

### Value Proposition
[What users get; why they will use this instead of alternatives]

### Goals & Metrics
| Goal | Success Metric | How Measured | Target |
|------|----------------|--------------|--------|
| [Goal 1] | [Metric] | [Method] | [Target value] |

## 2. Scope & Release Plan

### MoSCoW
- **Must:** [feature list]
- **Should:** [feature list]
- **Could:** [feature list]
- **Won't:** [feature list]

### MVP Boundary
[What defines v1 done — include use cases, features, surfaces]

### Release Phases
| Phase | Scope | Target Date | Notes |
|-------|-------|-------------|-------|
| v1.0 | [features] | [date] | Launch |
| v1.1 | [features] | [date] | [notes] |

### Out of Scope
[Explicit non-goals and deferred items]

## 3. Experience

### Top Journeys
[List the 5–8 main user journeys with links to prototype]
- [Journey name]: [brief description] — [link to prototype path]

### Screen Inventory (SCR-)
| ID | Purpose | Personas | States | Components |
|----|---------|-----------|---------|----|
| SCR-001 | [Purpose] | [Persona names] | [States: empty, loading, error, offline, success] | [Component list] |

### UX Principles
- **Content tone:** [e.g., formal, playful, reassuring]
- **Feedback & undo:** [error handling, confirmation patterns]
- **Accessibility:** [Target WCAG level, e.g., 2.2 AA]
- **Localisation:** [Languages, RTL, cultural considerations]

### UI Principles
- **Visual identity:** [Brand summary]
- **Density:** [Tight, normal, spacious]
- **Motion & haptics:** [Reduced-motion compliance, haptic feedback where applicable]
- **Theming:** [Light/dark/high-contrast mode support]

### Accessibility & Localisation
[WCAG level (e.g., 2.2 AA), supported languages, RTL considerations, cultural date/number/address formats]

**Links:**
- Wireframes: [link to docs/product/prototype/wireframes/]
- Mockups: [link to docs/product/prototype/mockups/]
- Clickable prototype: [link to docs/product/prototype/index.html]
- Validation log: [link to docs/product/prototype/validation-log.md]

## 4. Surfaces & Deliverables

### Deliverables Register (DLV-)
| ID | Deliverable | Platform(s) | Owner | Release Phase | Acceptance Criterion |
|----|----|-------|-------|-------|-----------|
| DLV-001 | [Name] | [Web / iOS / Android / Windows / macOS / API] | [Owner] | v1.0 | [Success criterion] |

### Distribution & Update Strategy
- **Web:** [PWA / SPA / server-rendered; hosting; auto-update mechanism]
- **Mobile:** [App stores; TestFlight / beta; auto-update]
- **Desktop:** [Installer type; auto-update; signed by ...]
- **API:** [Kiota client availability; versioning]

## 5. Domain

### Bounded Contexts
- [Context name]: [scope — the language and responsibilities of this context]

### Glossary
See [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) for full definitions.

### Use Cases & Stories
- [Use cases](../bounded-contexts/{Domain}/use-cases.md) — main flows per context
- [User stories](../bounded-contexts/{Domain}/user-stories.md) — acceptance criteria per capability

## 6. Technical Requirements

### Architecture Summary
[Core pattern — e.g., "CQRS with event sourcing"; bounded-context boundaries; data-flow shape; deployment topology]

**Architecture Document:** [Link to docs/architecture/{SolutionName}-architecture.md]

**Key ADRs:**
| Decision | Rationale | Link |
|----------|-----------|------|
| [ADR title] | [Why this was chosen over alternatives] | [link] |

### Dimensions 9–15 Decisions
[Reference the Interrogation order table; for each dimension asked, record the decision:]
- **Dimension 9 (Client Surfaces):** [Render modes per surface; shared UI strategy; design system; theming; offline/sync policy]
- **Dimension 10 (Identity & Access):** [Provider; flows per surface; tenancy; session lifetime per platform; API client auth]
- **Dimension 11 (Data Management):** [Stores per BC; retention & deletion; PII classification; backup/restore; migration]
- **Dimension 12 (Delivery & Hosting):** [Environments; CI/CD; branching/versioning; hosting platform; cost envelope; feature flags]
- **Dimension 13 (Observability):** [Logging; metrics; tracing; alerting; tracking plan; crash reporting; runbooks; SLA/SLO]
- **Dimension 14 (Testing):** [Test pyramid; BDD scope; E2E & accessibility baseline; device/browser/OS matrix; performance tests]
- **Dimension 15 (AI/ML):** *(if applicable)* [Model & provider; swap-ability; prompt/data privacy; evaluation gates; cost; EU AI Act classification]

### Dimension 7 Quality Attributes (Measurable)
| Attribute | Target | How Verified |
|-----------|--------|--------------|
| Performance | [e.g., <200ms p95 for list load; <1s page load] | [load test, APM, field monitoring] |
| Reliability | [e.g., 99.5% uptime; <2% error rate] | [monitoring, SLO, error tracking] |
| Security | [e.g., AES-256 for PII; TLS 1.3 for transit] | [audit, penetration test, code review] |
| Maintainability | [e.g., independent deployability per BC] | [architecture review, coupling analysis] |
| Flexibility | [e.g., database swappable, auth provider agnostic] | [contract tests, integration tests] |

### Constraints
- **Tech stack:** [Relevant selections from tech-stack.md]
- **Team:** [Size, skills, availability]
- **Timeline:** [Deadline and release rhythm]
- **Compliance:** [Regulations that constrain the design]
- **Hosting:** [On-premise, cloud, managed service; cost envelope]

**Forbidden-tech check:** [OK / Violations: list any violations found against forbidden-tech.md]

## 7. Compliance Register

| Requirement | Source | Owner | How Verified | Status |
|-------------|--------|-------|--------------|--------|
| [e.g., GDPR consent] | [Source: GDPR Art. 7 / Standard name / Regulation] | [Owner role] | [Test/audit method] | [Confirmed/In progress/Deferred] |
| [e.g., WCAG 2.2 AA] | [EN 301 549 / Customer requirement] | [Owner] | [Accessibility audit] | [Confirmed] |

**Cross-checked against:** `.ai/reference/standards.md` — [result: OK / gaps: list them with source]

### Compliance Source Map
| Requirement ID | From | Dimension | Decision ID |
|---|---|---|---|
| [REQ-001] | [discovery/interrogation] | [1-15] | [PD-nnn / session-decision row] |

## 8. Roadmap & Rough Sizing

### Capability Sizing
| Capability | T-Shirt Size | Effort (days) | Priority | Dependencies |
|------------|------------------|--------|----------|--------------|
| [Feature 1] | M | [8–12 days] | Must | [Dependencies] |

### Critical Path
[Longest dependency chain; key milestone dates; bottleneck items]

### Scope vs. Budget/Deadline
**Verdict:** [Fits / Tight / Overcommitted]

**If overcommitted — MVP cut proposal:**
- **Must keep in v1.0:** [core features; critical use cases]
- **Could defer to v1.1:** [nice-to-have features; non-critical flows]

### Sizing Source Map
| Estimate | From | Dimension | Decision ID |
|---|---|---|---|
| [Capability] T-shirt size | [discovery Phase 5 / interrogation] | [Dimension 12] | [PD-nnn / session-decision row] |
| Budget/deadline fit | Interrogation | [Dimension 12 & 14] | [session-decision rows] |

## 9. Traceability Matrix

### Goal → Capability → Screen / Use Case / Story → Surface → Architecture Decision

| Goal | Capability | Screen(s) | Use Case(s) | Story(ies) | Surfaces | Key Architecture Decision |
|------|------------|----------|-------------|-----------|----------|--------------------------|
| [G1] | [Feature name] | SCR-001 / SCR-002 | UC-{BC}-001 | US-{BC}-001 / US-{BC}-002 | Web, iOS | Dimension 9 (Blazor WASM), Dimension 10 (OAuth), Dimension 11 (PostgreSQL) |

### Uncovered Goals
[List any goals that lack a capability, screen, use case or story. Record reason and owner for follow-up.]

### Traceability Source Map
| Element ID | From | Dimension | Decision ID |
|---|---|---|---|
| [GL-nnn] | [discovery Phase 4 / interrogation Dimension 1] | [1 or 12] | [PD-nnn / session-decision row] |
| [UC-{BC}-nnn] | [interrogation] | [Dimensions 1-6 per BC] | [session-decision rows] |
| [US-{BC}-nnn] | [interrogation] | [Dimensions 1-6 per BC] | [session-decision rows] |

## 10. Risks, Assumptions, Deferred Decisions, Open Questions

### Risks
| Risk | Impact (High/Med/Low) | Owner | Mitigation | Review Date |
|------|--------|-------|------------|-------------|
| [Risk 1] | High | [Owner] | [Mitigation strategy] | [Date] |

### Assumptions
| Assumption | Validation Method | Owner | Validation Date |
|-----------|------|-------|------|
| [Assumption 1] | [How to validate: testing, user research, technical proof] | [Owner] | [Target date] |

### Deferred Decisions
| Decision | Reason | Owner | Target Date |
|----------|--------|-------|-------------|
| [Decision 1] | [Why deferred; what depends on it] | [Owner] | [Date] |

### Open Questions
| Question | Owner | Estimated Resolution |
|----------|-------|-----------|
| [Question 1] | [Owner] | [How and when will it be resolved] |

### Risks & Assumptions Source Map
| Item ID | From | Dimension | Status | Decision ID |
|---|---|---|---|---|
| [Risk-001] | [discovery Phase 16 / interrogation] | [1-15] | [Identified/Mitigated] | [PD-nnn / session-decision row] |
| [Assumption-001] | [discovery / interrogation] | [1-15] | [To validate/Validated] | [PD-nnn / session-decision row] |

## 11. Sign-Off

**Confirmed by:**
- [Name], [Role/Decision Rights] — [Date]
- [Name], [Role/Decision Rights] — [Date]

**Conditional approvals:**
[Any "yes, if ..." approvals — e.g., "Approved if security review is completed by {date}"]

### Sign-Off Source Map
| Approval | From | Who | Dimension(s) | Scope |
|---|---|---|---|---|
| [Deliverable approval] | [discovery Phase 17 / interrogation completion] | [Decision owner] | [All] | [Scope coverage, feasibility verdict] |
| [Deferred items approval] | [interrogation] | [Decision owner] | [1-15] | [Items marked Deferred or N-A with reason] |

**Next steps:**
1. Run `.ai/skills/solution-generator/SKILL.md` — pass architecture document and this specification as input
2. Translate user stories to `.ai/skills/vertical-slices/SKILL.md` blueprints
3. Run **designer** for design-system refinement
4. Run `.ai/skills/playwright-tester/SKILL.md` against the prototype baseline
5. Run `.ai/skills/gap-review/SKILL.md` after generation
