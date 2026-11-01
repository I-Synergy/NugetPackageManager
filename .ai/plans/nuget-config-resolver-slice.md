# Plan: move NuGet config resolution into the C# core

Status: IMPLEMENTED (2026-11-01) — see `.ai/completed/nuget-config-resolver-slice.md`.

The pure-logic files I originally offered to move are not movable:

| File | Size | Consumers | Verdict |
|---|---|---|---|
| `Common/framework.ts` | 50 lines | 4 webview components (`updates-view`, `packages-view`, `package-row`, `consolidate-view`) | Runs in the browser bundle during render — an RPC hop per call is not acceptable |
| `Common/text.ts` | 21 lines | `webview/components/actionable-error.ts` | Same |
| `Common/package-range.ts` | 24 lines | `webview/components/updates-view.ts` | Same |
| `Common/nonce.ts` | 3 lines | `main.ts`, host panel creation | Uses `globalThis.crypto` in both contexts — cannot be a sidecar call |
| `Common/configuration.ts` | 39 lines | 6 files, host + web | Imports `vscode` |
| `Host/utilities/nuget-identifier.ts` | 12 lines | `host-api.ts` (synchronous guard) | Would become async for ~12 lines of regex |
| `Host/utilities/project-scope.ts` | 29 lines | `host-api.ts` (synchronous filter) | Imports `node:path`; same async problem |

Net: ~0 lines worth moving. The remaining TS is either the VS Code surface or the browser bundle.

The genuine candidate is `Host/utilities/nuget-config-resolver.ts` — **440 lines of logic plus
666 lines of tests**, no webview dependency, and it duplicates what `NuGet.Configuration` models.

## What moves and what stays

**Moves to C# (`src/NugetPackageManager.Core.NuGet/Configuration/`):**

| Concern | TS today | C# target |
|---|---|---|
| Config file discovery and priority order (machine → user → workspace folders) | `FindAllConfigFiles`, `CollectWorkspaceConfigFiles` | `NuGetConfigDiscovery` |
| XML parsing: `<packageSources>`/`<clear/>`, `<disabledPackageSources>`, `<packageSourceCredentials>`, `<packageSourceMapping>`/`<clear/>`, `_xHHHH_` name decoding | `ParseConfigFileAsync`, `ParseCredentialNode`, `DecodeNuGetXmlName` | `NuGetConfigParser` |
| Merge across files, `<clear/>` reset semantics, credential and mapping attachment | `ResolveConfigsAsync` | `NuGetConfigMerger` |
| Sidecar surface | — | handler `nugetConfig.resolve` → `{ Sources, ClearFound }` |

**Stays in TypeScript (security boundary and VS Code API):**

- `applyVscodeSources` — reads the `nugetpackagemanager.sources` setting.
- `vscode.workspace.isTrusted` gate, `passwordScriptAllowlist` read.
- `IsPasswordScriptAllowedAsync` — realpath containment before any spawn.
- `PasswordScriptExecutor.ExecuteScriptAsync` — the only code allowed to run a script.
- `LocalNuGetFeed.IsLocalSource`, `IsHttpSource`, logging, `filterSupportedSources`.

## Security invariants (tests are mandatory)

1. **No environment expansion for workspace configs.** `%VAR%` may only expand in machine- and
   user-level configs (`expandEnvironment` today). The C# parser must take that flag per file, never
   globally. If `NuGet.Configuration` is used, it expands by default — pass an
   `IEnvironmentVariableReader` that returns empty for workspace-level settings, or keep the
   hand-rolled parser.
2. **A workspace `<clear/>` still blocks VS Code settings sources.** `ClearFound` is returned so the
   TS layer keeps that decision.
3. **Credentials never leave the process except to the host that asked.** Passwords cross stdio in
   the response, are never logged by either side, and are not cached on disk.
4. **Password scripts still require trust + allowlist + realpath containment, checked in TS before
   the spawn.** The port must not move that check into C#.

## Contract sketch

```
request:  { WorkspaceRoots: string[], Platform: "win32"|"linux"|"darwin",
            Environment: { APPDATA?, ProgramFiles?, Home? } }
response: { Sources: [{ Name, Url, Username?, Password?, Patterns? }], ClearFound: bool }
```

`Platform`/`Environment` are explicit so the discovery order is testable without touching the host
machine, and so the host remains the authority on what the developer's environment is.

## Steps

1. Add `Core.NuGet/Configuration/` with discovery, parser and merger; MSTest coverage ported from the
   666-line TS suite.
2. Add the `nugetConfig.resolve` handler + protocol DTOs; test the NDJSON round trip.
3. Add the host adapter (`nuget/config-client.ts`) and reduce `nuget-config-resolver.ts` to
   `GetSourcesAndDecodePasswordsAsync` composition.
4. Run both suites and diff behaviour against the golden fixtures; delete the now-duplicated TS
   parsing tests, keep the VS Code-source and allowlist ones.
5. Update AGENTS.md/CLAUDE.md/README architecture notes.

## Risks

- **Behaviour drift** — the current merge order and per-file `expandEnvironment` have edge cases
  (`clearMappings`, sibling workspace configs, `%VAR%` only above workspace level). Golden tests
  come first; the port is a refactor, not a redesign.
- **Two parsers during the transition** — must not ship both reading the same config.
- **Scope creep into `local-feed.ts`** — the `.nupkg` reader needs JSZip and stays TS.

## Estimated size

~350 lines C# + tests; ~200 lines TS removed, adapter ~80 lines; ~60 % of the TS test file moves,
40 % stays.
