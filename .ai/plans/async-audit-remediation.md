# Async Audit Remediation

Status: DONE (2026-11-01)
Date: 2026-11-01
Source: compiler-API audit of `src/` + `tests/` (368 async declarations) and a C# scan.

## Findings being fixed

C# is compliant and untouched. TypeScript has 6 naming violations of the
`*Async` rule and 7 fire-and-forget promise calls.

### Renames (rule 2 in AGENTS.md — async method name ends with `Async`)

| File | Current | New |
|---|---|---|
| `Host/utilities/global-json.ts:53` | `UpdateGlobalJsonSdkVersion` | `WriteGlobalJsonSdkVersionAsync` (the file already exports `UpdateGlobalJsonSdkVersionAsync` for the template path) |
| `Host/host-api.ts:3395` | `recordRestoreFailure` | `recordRestoreFailureAsync` |
| `Host/host-api.ts:3662` | `executeRemovePackage` | `executeRemovePackageAsync` |
| `Host/host-api.ts:3676` | `executeAddPackage` | `executeAddPackageAsync` |
| `Host/host-api.ts:3709` | `getLatestVersion` | `getLatestVersionAsync` |
| `Webview/components/packages-view.ts:818` | `runNext` (async local) | `runNextAsync` |
| `tests/.../rpc/rpc.test.ts:90` | `receive` (async local) | `receiveAsync` |
| `tests/.../nuget/local-feed.test.ts:19` | `writePackage` | `writePackageAsync` |

Call sites to update with each rename: `global-json.ts` (2 recursive + definition),
`host-api.ts` (import, 5 call sites, 2 `typeof` type expressions), `packages-view.ts`
(`Array.from` worker list), the two test files.

### Unawaited promise calls

| File | Fix |
|---|---|
| `Common/logger.ts:72` | `void this._provider.shutdown()` |
| `Common/rpc/rpc-host.ts:55` | `void this.webview.postMessage(response)` |
| `Host/host-api.ts:2572` | `void vscode.env.openExternal(...)` |
| `Host/extension.ts:97` | `void context.globalState.update(...)` (`activate` is sync) |
| `Host/extension.ts:141` | `void vscode.env.openExternal(...)` |
| `Webview/components/packages-view.ts:809` | `void hostApi.updateStatusBarAsync({...})` |
| `Webview/components/packages-view.ts:636` | `void this.debouncedLoadProjectsPackages()` |
| `Host/utilities/package-version-decorator.ts:82` | `void this.updateDecorationsAsync(editor).catch(...)` |

### Deliberately not changed

- `packages-view.ts:443` `void this.LoadProjectsAsync()` in `connectedCallback` — the rule's
  documented last-resort case, carries an explanatory comment; converting it to `@lit/task`
  would change load semantics (Task re-runs on input change), so it stays.
- The 8 `task:` arrows inside `new Task(this, { task: async … })` — Lit's own property name.
- Test doubles implementing `postMessage` / `writeText` / `update` — names fixed by the
  `vscode` interfaces.

## Verification

`npm run typecheck`, `npm run lint`, `npm test`, `npm run quality`, plus a re-run of the
compiler-API audit to confirm the violation counts drop to zero.
