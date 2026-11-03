# Make the Installed tab's update arrow work

Status: APPROVED (2026-11-03, user report with screenshot)
Started: 2026-11-03

## Symptom

In the **Installed** tab the circled up arrow next to a package version does nothing. Clicking it
only selects the row (the details pane opens); no update is written.

## Cause

`package-row.renderVersionContent()` renders the arrow as a decorative
`<span class="codicon codicon-arrow-circle-up">` with no click handler, no button semantics and no
hover affordance. The only action on an installed row is `@click` → `SelectPackageAsync`.

## Fix

### 1. `src/NugetPackageManager.VSCode.Webview/components/package-row.ts`

- Render the arrow as a real `<button class="icon-btn update-indicator">` with
  `title`/`aria-label` naming the target version (`Update <Id> to <Version>`).
- On click: stop propagation (so the row does not also select) and dispatch a
  `package-update-requested` custom event (`bubbles: true`, `composed: true`) with
  `detail: { package }`.
- New `@property({ type: Boolean }) updating`; while true show a small spinner instead of the
  button.

### 2. `src/NugetPackageManager.VSCode.Webview/components/packages-view.ts` (Installed tab)

- Track in-flight rows with a replaced `Set<string>` keyed by `Id\0CpmFramework`
  (`updatingInstalledKeys`), pass `.updating=${…}` to `package-row`, and handle
  `@package-update-requested`.
- `UpdateInstalledPackageAsync(pkg)` resolves targets from `this.projects`, limited to the same
  project scope `LoadProjectsPackagesAsync` used (`selectedProjectPaths`, else all) and to the
  row's framework:
  - **framework-scoped row** (`pkg.CpmFramework !== ""`): include projects whose
    `CpmResolutions` has `Tfm === pkg.CpmFramework`; group projects by that resolution's
    `Condition` and send one entry per condition with `CpmCondition` + `CpmTfm` + `Scope: "group"`.
  - **shared row** (`pkg.CpmFramework === ""`): include projects whose resolution is
    unconditional (`Tfm === ""`) or that have no `CpmResolutions`; send `Scope: "unconditional"`.
- Target version is `pkg.Version` — the latest version the Installed row already compares against
  (`UpdatePackageAsync` keeps it at the feed's latest). No change to the runtime-alignment or
  cross-major policy: a click is an explicit update to the version the arrow advertises.
- Run the write as one host job:
  `runBatchUpdateJobAsync({ Transactional: true, Updates: [...] })` — snapshot, restore and
  rollback come for free; no new RPC method.
- On success: set `installedUpdateStatus = "Updated <Id> to <Version>"` and call the existing
  `onPackagesUpdatedAsync()` (reloads the workspace and refreshes the child tabs).
- On failure/cancel/rollback: set `installedUpdateError` from the response and leave the rows in
  place.
- Add `@state()` `installedUpdateStatus` / `installedUpdateError` and render a compact
  status/error line under the Installed header.

### 3. Tests

- `tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Webview/components/package-row.test.ts`
  - the arrow is a `<button>` with an aria-label naming the version;
  - clicking it dispatches `package-update-requested` with the package;
  - the click does not reach the row handler (selection is not triggered);
  - `updating = true` swaps the button for a spinner.
- `tests/NugetPackageManager.VSCode.Tests/NugetPackageManager.VSCode.Webview/components/packages-view.test.ts`
  - an unconditional installed row sends one batch entry with `Transactional: true`, the row's
    version, `Scope: "unconditional"` and the expected project paths;
  - a framework-scoped row sends `CpmCondition` + `CpmTfm` + `Scope: "group"` and only the
    projects that resolve that TFM;
  - a failed/rolled-back response sets the error and does not report success;
  - success refreshes the workspace.

### 4. Docs

- `CHANGELOG.md`: the Installed arrow now updates the package.
- `README.md` → **Installed**: one sentence that the row's up arrow updates the package across
  the projects that use it.

## Non-goals

- No change to the Updates tab, Consolidate, or the project-row update flow.
- No new RPC method, request shape or sidecar change.
- No confirmation dialog: this is a row-level action, matching the Updates tab's per-row arrow.

## Verification

- Focused tests for both components, then `npm run typecheck`, `npm run lint`, `npm test`.
- Manual: Installed → click the arrow → spinner, version change, status line, Updates count
  refresh; a pinned row still shows no arrow.
- `npm run quality` before finishing.
