# Wave 2 — one package row across the tabs

Status: DONE
Started: 2026-11-02
Completed: 2026-11-02
Scope: make Updates, Consolidate and Vulnerabilities render the same `package-row`
Owner: Reasonix Code

## Design

`package-row` keeps the Browse/Updates card and gains slots so the compact tabs can
reuse it without copying the header markup:

| Slot | Used by | Content |
|---|---|---|
| `leading` | Vulnerabilities | severity badge |
| `badges` | Consolidate, Vulnerabilities | CPM, TFM, transitive |
| `actions` | Consolidate, Vulnerabilities | version dropdown / consolidate button / advisory link |
| `details` | Consolidate, Vulnerabilities | per-tab version or advisory body |

New flags: `showIcon`, `showDescription`, `showMeta`, `showVersion`, `showAuthors`,
`selectable` (name click emits `package-selected`).

The parent keeps its card wrapper (`.inconsistent-row`, `.vuln-row`) and its
`version-details` / `vuln-details` styles; only the duplicated header markup moves
into `package-row`. Updates already uses the component and only needs the slots if
its sibling controls are moved.

## Steps

- [ ] Extend `package-row` with the slots, flags and `package-selected` event.
- [ ] Migrate Consolidate's row header/actions into the slots.
- [ ] Migrate Vulnerabilities' severity/badges/advisory into the slots.
- [ ] Move the badge/action CSS out of the now-removed `.row-header` blocks.
- [ ] Add/update component tests, then run typecheck, tests and esbuild.
