# Tab refresh aborts itself: keep `forceReload` out of `@lit/task` args

Status: DONE
Started: 2026-11-03

## Steps

- [x] `CANCELLED_ERROR` + `isCancelledMessage` in `result.ts`, host uses them
- [x] `updates-view`: `forceReload` via a field, `run()` without args, cancel-aware error card
- [x] `consolidate-view` and `vulnerabilities-view`: same task-args fix
- [x] view tests updated + new stability/cancel tests
- [x] verification + rebuilt test VSIX

## Evidence

- `npm run quality` — PASS, 8/8 steps.
- Targeted suites: updates/consolidate/vulnerabilities 38, HostAPI 70, other webview 109.
- VSIX `2026.11103.11349` (9.51 MB, 41 files), manifest verified, `dist/core` rebuilt 14:50.
- Trigger: aspire screenshot showed "Failed to check for updates" with an `AbortError` stack.

## Notes

Plan: `.ai/plans/tab-refresh-task-args.md`.
