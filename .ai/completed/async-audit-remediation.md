# Async Audit Remediation
Status: DONE
Started: 2026-11-01

Plan: `.ai/plans/async-audit-remediation.md`

## Steps
- [x] Rename the 6 production `async` functions to end in `Async`
- [x] Rename the 2 test-local `async` helpers
- [x] Add `void` / `await` at the 8 unawaited promise sites
- [x] Verify: typecheck, lint, tests, quality gate, audit re-run

## Notes

- Audit after the fix: 0 async functions without the `Async` suffix in production code,
  0 Promise-returning members without the suffix, 0 unawaited promise expressions.
  Remaining hits are the accepted false positives (Lit's `task:` property name, test doubles
  implementing `postMessage` / `writeText` / `update`).
- One rename needed a different shape than planned: `global-json.ts` already exported two
  entry points (`UpdateGlobalJsonSdkVersion` and `UpdateGlobalJsonSdkVersionAsync`, told apart
  by their options type). Collapsing both onto one name broke compilation, so the core writer
  is now `WriteGlobalJsonSdkVersionAsync` and the template-creating wrapper keeps
  `UpdateGlobalJsonSdkVersionAsync`; `host-api.ts` imports and calls each explicitly.
- `npm run typecheck`, `npm run lint`, `npm test` (358) and `npm run quality` (8/8) all pass.

