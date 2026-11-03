# Tab refresh aborts itself: keep `forceReload` out of `@lit/task` args

Status: APPROVED (2026-11-03, from the aspire test run)
Started: 2026-11-03

## Symptom

Aspire test build `2026.11103.11336`: the Updates tab shows **"Failed to check for updates"**
and the output pane prints an `AbortError` stack ending in the Electron message port.

## Root cause

All three data tabs call the task with an imperative argument that the task's `args()` does not
produce:

```ts
// updates-view.ts
args: () => [this.projectPaths, this.sourceUrl, this.prerelease, false] as [...]
...
await this._loadTask.run([this.projectPaths, this.sourceUrl, this.prerelease, forceReload]);

// consolidate-view.ts / vulnerabilities-view.ts
args: () => [this.projectPaths, false] as [...]
await this._loadTask.run([this.projectPaths, forceReload]);
```

`@lit/task` stores the arguments a run was started with and, on the next host update, compares
them against `args()`. `packages-view.setTabAsync` forces a reload (`true`), the stored args are
`true`, `args()` returns `false` → **the controller treats it as a change, aborts the in-flight
request and starts a second one**. The abort travels to the host as `rpc-cancel`; the host
returns "The request was cancelled."; the view throws; `TaskStatus.ERROR` renders the failure
card. Every tab switch and refresh does this, and each aborted scan burns a real request.

## Fix

1. `src/NugetPackageManager.VSCode.Common/rpc/result.ts`
   - `export const CANCELLED_ERROR = "The request was cancelled.";`
   - `export function isCancelledMessage(message: string): boolean;`
2. Host: `fail(CANCELLED_ERROR)` in `getOutdatedPackagesAsync` and
   `loadWorkspaceProjectsAsync` instead of the inline literal (same text).
3. `updates-view`, `consolidate-view`, `vulnerabilities-view`:
   - A `private _forceReloadNext = false` field carries the imperative flag.
   - `args()` no longer contains the flag.
   - The `task` reads and clears the field; `Load*Async(forceReload)` sets it and calls
     `this._loadTask.run()` **without arguments**.
   - The task state is then stable across re-renders, so a forced load really is one request.
4. `updates-view` error rendering:
   - `renderError()` returns `nothing` when the run was cancelled
     (`isCancelledMessage(this._loadTask.error?.message)`), and otherwise shows the real reason:
     `Failed to check for updates` plus the host's message as detail text (today it is discarded).
   - `onError` keeps resetting `isRefreshing`.

## Tests

- `updates-view.test.ts`, `consolidate-view.test.ts`, `vulnerabilities-view.test.ts`: update the
  task-run call shape and add one test each that a forced load issues exactly one request and
  that a following `updateComplete`/re-render does not issue a second (the args are stable).
- `updates-view.test.ts`: a cancelled response renders no error card; a real failure renders the
  host's message.

## Verification

`npm run quality`, then a new test VSIX. On aspire: switching to Updates issues one request, no
`AbortError`, and `outdatedScans: attached to scan …` appears instead of two `started` lines.
