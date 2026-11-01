# Progress: Async Method Naming Refactor

Status: SUPERSEDED (2026-11-01)

> **Superseded.** This file was written against the pre-refactor TypeScript layout
> (`src/common/…`, `src/host/…`, `src/web/…`), which no longer exists: the tree is now
> `src/NugetPackageManager.VSCode.{Common,Host,Webview}` plus the C# core, and the tests moved to
> `tests/NugetPackageManager.VSCode.Tests`. Every step below was abandoned rather than completed.
> The `Async`-suffix rule itself is still in force — see `AGENTS.md` → *Critical Coding Rules* →
> *2. Async all the way, and name it `Async`*. If the sweep is ever restarted, re-derive the file
> list from the current tree; do not resume these paths.

- [ ] Step 1: src/common/rpc/types.ts (HostAPI interface - 16 renames)
- [ ] Step 2: src/host/host-api.ts (implementations - 16 renames)
- [ ] Step 3: src/common/rpc/rpc-host.ts
- [ ] Step 4: src/host/nuget/api.ts (3 private methods)
- [ ] Step 5: src/host/nuget/api-factory.ts
- [ ] Step 6: src/host/utilities/task-executor.ts
- [ ] Step 7: src/host/utilities/project-parser.ts
- [ ] Step 8: src/host/utilities/password-script-executor.ts
- [ ] Step 9: src/host/utilities/nuget-config-resolver.ts
- [ ] Step 10: src/host/utilities/cpm-resolver.ts
- [ ] Step 11: src/host/utilities/package-version-decorator.ts
- [ ] Step 12: src/web/configuration.ts
- [ ] Step 13: src/web/components/packages-view.ts
- [ ] Step 14: src/web/components/updates-view.ts
- [ ] Step 15: src/web/components/consolidate-view.ts
- [ ] Step 16: src/web/components/vulnerabilities-view.ts
- [ ] Step 17: src/web/components/search-bar.ts
- [ ] Step 18: src/web/components/settings-view.ts
- [ ] Step 19: src/web/components/project-row.ts
- [ ] Step 20: Other web components (hostApi call sites only)
- [ ] Step 21: Test files
- [ ] Step 22: Build + lint + test verification
