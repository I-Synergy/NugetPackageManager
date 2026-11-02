# Webview deduplication — shared formatters and copy helpers

Status: DONE
Started: 2026-11-02
Completed: 2026-11-02
Scope: wave 1 (cross-tab functions only; row/layout components are wave 2)
Owner: Reasonix Code

## Audit

| Duplicate | Copies | Shared home |
|---|---|---|
| `formatDownloads` | `package-details.ts:317`, `package-row.ts:205` | `@/common/package-display.ts` |
| prerelease check (`includes("-")`) | `package-details.ts:491`, `packages-view.ts:1108` | `@/common/package-display.ts` |
| toolchain diagnostics copy (RPC + clipboard + feedback) | `actionable-error.ts:223`, `toolchain-banner.ts:175`, `toolchain-view.ts:274`, `settings-view.ts:305` | `@/web/utilities/diagnostics.ts` |
| clipboard write wrapper | `actionable-error.ts:234`, `toolchain-banner.ts:182`, `toolchain-view.ts:266/281`, `settings-view.ts:310` | `@/web/utilities/diagnostics.ts` |
| `recommendedVersion(health)` | `toolchain-banner.ts:166`, `toolchain-view.ts:345` | `@/web/utilities/toolchain.ts` |

Already shared and left alone: `@/common/framework` (framework options/filtering),
`package-row`, `actionable-error`, `dependency-issues`, the framework selector in
`packages-view`.

Not duplicates (type-specific, left alone): `renderPackageRow` variants,
`renderIssue`, `reportCount`, `cancelJobAsync`.

## Steps

- [ ] Add `package-display.ts` with `FormatDownloads` and `IsPrereleaseVersion`.
- [ ] Add `webview/utilities/diagnostics.ts` with `CopyTextAsync` and
      `CopyToolchainDiagnosticsAsync`.
- [ ] Add `webview/utilities/toolchain.ts` with `RecommendedSdkVersion`.
- [ ] Replace the duplicate implementations in the components.
- [ ] Add `package-display.test.ts` and run typecheck, tests and esbuild.

## Wave 2 (follow-up)

- Shared package header/badges for Updates, Consolidate and Vulnerabilities rows.
- Shared job-cancel helper used by `project-row`, `updates-view`, `packages-view`.
