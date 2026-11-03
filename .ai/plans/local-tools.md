# Local .NET Tools — detect, version-update and health

Status: AWAITING APPROVAL
Created: 2026-11-03
Author: Reasonix Code
Scope decision: detect + explicit per-tool update + health (no batch, no audit badge yet)
Surface decision: section inside the Toolchain tab

## Problem

The extension manages NuGet packages in projects and `Directory.Packages.props`, but a repository
also pins **local tools** in `.config/dotnet-tools.json`. Those packages are resolvable by NuGet,
yet today they are invisible: no outdated check, no vulnerability coverage (`dotnet list package
--vulnerable` ignores tools), and no way to tell whether the tools a repo declares are restored or
even runnable with the selected SDK.

## Goal

1. Discover every local tool manifest in the workspace and show its tools with the command names,
   the pinned version and the latest eligible version.
2. Update **one** tool at a time on an explicit user action, then verify with `dotnet tool restore`.
3. Add two Toolchain health findings: a manifest that cannot be parsed, and a declared tool that is
   not restored on this machine.
4. Never update global tools, never batch-update tools, never auto-update.

## Design

### Where it lives

- Core owns manifest discovery, parsing, rewriting and latest-version selection.
- Host owns every `dotnet` spawn (`dotnet tool list --local`, `dotnet tool restore`), the RPC
  handler and workspace-path validation — the same split as `evaluateToolchain`.
- Webview gets a "Repo tools" card inside `toolchain-view`, grouped by manifest path.

### Contract additions (all additive)

```ts
// src/NugetPackageManager.VSCode.Common/rpc/types.ts
export type LocalTool = {
  Id: string;
  /** Command names the manifest declares; the id is not what users type. */
  Commands: string[];
  Version: string;
  /** `rollForward: false` in the manifest — a deliberate pin. */
  Pinned: boolean;
  LatestVersion?: string;
  UpdateAvailable: boolean;
  /** Best-effort: the package is missing from the global packages folder. */
  NotRestored: boolean;
};

export type LocalToolManifest = {
  /** Absolute path; the webview renders it relative to the workspace root. */
  Path: string;
  /** `isRoot` from the manifest. */
  IsRoot: boolean;
  Tools: LocalTool[];
  /** Parse errors, duplicate ids or duplicate commands. */
  Problems: string[];
};

export type GetLocalToolsRequest = {
  WorkspaceRoots: string[];
  ProjectPaths?: string[];
  Prerelease?: boolean;
  /** Skip the NuGet lookup (offline / quick re-render). */
  ResolveLatest?: boolean;
  ForceRefresh?: boolean;
};

export type GetLocalToolsResponse = { Manifests: LocalToolManifest[] };

export type UpdateLocalToolRequest = {
  ManifestPath: string;
  ToolId: string;
  /** Optimistic concurrency: the version the row was rendered from. */
  ExpectedVersion: string;
  Version: string;
  WorkspaceRoots: string[];
};

export type UpdateLocalToolResponse = {
  ManifestPath: string;
  ToolId: string;
  PreviousVersion: string;
  Version: string;
  /** Null when `dotnet tool restore` was not attempted. */
  Restore: { Ok: boolean; TimedOut: boolean; Message?: string } | null;
};

// ToolchainHealth gains (optional, so existing consumers keep compiling):
//   LocalToolManifests?: string[];
//   LocalToolsNotRestored?: string[];
```

`GetToolchainHealthAsync` response also gains `LocalTools: LocalToolManifest[]`, so one call feeds
both the health issues and the new card.

### Core

New folder `src/NugetPackageManager.Core.Workspace/Tools/`:

| File | Responsibility |
|---|---|
| `LocalToolManifestLocator.cs` | From workspace roots and project directories, walk up to each containing folder and collect `.config/dotnet-tools.json`; dedupe by real path; skip `bin`, `obj`, `node_modules`, `.git`, `.vs`; never leave the workspace root. |
| `LocalToolManifestReader.cs` | Parse `{ version, isRoot, tools: { id: { version, commands, rollForward } } }` with `System.Text.Json`; keep the raw text and the tool order so a rewrite is a targeted edit. Report unknown versions, missing `version`, duplicate commands. |
| `LocalToolManifestWriter.cs` | Change exactly one tool's `version` in the original JSON text (no full re-serialize), then verify: parses, the target has the new version, every other tool and field is byte-identical. Refuse when the current version differs from `ExpectedVersion`. One read/write per manifest, mirroring `CpmWriter`. |
| `LocalToolOutdatedResolver.cs` | For each tool id call the existing `INuGetSource.GetPackageAsync(id, prerelease)`; choose the highest stable version (prerelease only when the manifest or the caller allows it); never propose a downgrade or the same version. Cache per id+prerelease for the document generation. |

New `src/NugetPackageManager.Core/ToolHandlers.cs` (registered in `Program.cs`):

- `readLocalTools` — params match `GetLocalToolsRequest`; returns manifests with latest versions.
  `ResolveLatest: false` returns manifests with `UpdateAvailable: false` and no NuGet calls.
- `updateLocalTool` — validates `manifestPath` is inside a workspace root, applies the writer, and
  returns the previous/new version. **No `dotnet` spawn here**; the host restores.

`src/NugetPackageManager.Core/Toolchain/ToolchainAnalysis.cs`: accept a new optional
`LocalTools` input slice and emit two issue kinds:
`LocalToolManifestInvalid` and `LocalToolNotRestored`. No new I/O in the pure evaluator.

### Host

- `utilities/local-tools.ts`
  - `ReadLocalToolsAsync(...)` — calls `coreProcess.CallAsync("readLocalTools")`; on
    `ResolveLatest: true` passes the resolved source list from `config-client`/`source-api` the
    same way `getOutdatedPackages` does.
  - `UpdateLocalToolAsync(...)` — `workspace-path` validation, core write, then
    `dotnet tool restore` with **cwd = manifest directory** (a nested manifest is only found from
    its own folder), 120 s timeout, output captured. A failed restore leaves the manifest updated
    and reports it; it does not roll back silently — the user sees both facts.
  - Restore probe for health: global packages folder existence check
    (`~/.nuget/packages/<id>/<version>`) as a best-effort signal. Rationale: `dotnet tool list
    --local` reads the manifest and does not prove the tool was downloaded. The implementation
    must confirm that during step 4; if a cheaper authoritative check exists, use it.
- `host-api.ts`: `getLocalToolsAsync`, `updateLocalToolAsync` (both `Result<T>`), and merge local
  tools into `getToolchainHealthAsync`.
- `utilities/toolchain-health.ts`: probe manifests alongside the SDK probe, reuse the existing
  cache, invalidate on update. **Not** threaded through `workspaceSnapshot` — tools are not part
  of the parsed project model.
- Diagnostics report (`CopyToolchainDiagnosticsAsync`): append manifest paths, tool ids/versions
  and restore state.

### Webview

`components/toolchain-view.ts` gains a "Repo tools" card below the SDK summary:

- One group per manifest, header = workspace-relative path + "pinned"/`isRoot` markers.
- One row per tool: command names, id, `current → latest`, and an `Update` button only when
  `UpdateAvailable`. Update is per-row; there is no "Update all".
- Inline status line per row (updating, updated, "manifest updated — restore failed: …",
  cancelled, error). Button disabled while that row runs.
- Pinned tools (`rollForward: false`) show a "pinned" badge; the button stays available because
  the action is explicit.
- Empty state: "No local tool manifest in this workspace" with the `.config/dotnet-tools.json`
  hint.
- All listeners stored as class fields and removed in `disconnectedCallback`; no timers.

## Steps

1. Create `.ai/progress/local-tools.md`; add the contract types and wire the two new core
   handlers (`Program.cs`), returning empty manifests.
2. Implement locator + reader + writer in `Core.Workspace/Tools` with MSTest fixtures under
   `tests/NugetPackageManager.TestUtilities/Fixtures/tools/` (single tool, multiple tools with
   `rollForward: false`, nested manifests, malformed JSON, unknown fields, CRLF + BOM).
3. Implement `LocalToolOutdatedResolver` and the `readLocalTools` / `updateLocalTool` handlers;
   wire `ToolchainAnalysis` findings and unit tests for both issue kinds.
4. Implement `utilities/local-tools.ts` and the `HostAPI` methods; add path validation, the
   restore probe, and the health merge. Settle the "is it restored?" probe question here.
5. Add the "Repo tools" card to `toolchain-view` with component tests.
6. Extend the diagnostics report; update `README.md` and `CHANGELOG.md`.
7. Run `npm run quality` (or the relevant subset) and `dotnet test`, then move the progress file
   to `.ai/completed/` and write the session handoff.

## Verification

- `dotnet test NugetPackageManager.slnx -c Release` — locator, reader, writer, resolver, issues.
- `npm run typecheck`, `npm run lint` — strict TS on the new types and component.
- `npm test` — host tests for discovery/merge/restore and web tests for the card.
- `npm run test:e2e` (opt-in) against a fixture repo with a local manifest: read, update one tool,
  confirm the manifest diff and a successful restore.
- Multi-TFM regression checklist is not triggered (no `CpmResolutions`, no version rows in
  Installed/Updates/Consolidate/Vulnerabilities are touched).

## Guardrails

- Local manifests only. Global tools are machine state and stay out of scope.
- No batch, no auto-update, no downgrade, no prerelease without explicit opt-in.
- Writes require a trusted workspace (consistent with `untrustedWorkspaces.supported: false`).
- Update is never applied if `ExpectedVersion` no longer matches the manifest (someone edited it).
- A successful restore on this machine does not claim the manifest works on another platform:
  .NET 10 tools can be RID-specific, so the UI reports restore state per machine, not "verified".
- Tool updates must not invalidate the workspace snapshot or trigger a project re-parse; refresh
  the tool list and the toolchain probe only.

## Risks

| Risk | Handling |
|---|---|
| Tool needs a newer runtime/SDK than the repo builds with | Surface the `dotnet tool restore` failure verbatim per row; no proactive TFM analysis in this pass. |
| Manifest formatting churn in a reviewed PR | Targeted text edit + verification; fixture test asserts byte-identical untouched tools. |
| Multiple/ambiguous manifests | Group by absolute path, always show the path, run every `dotnet` command in that folder. |
| Network cost of latest-version lookup | Per-document cache, `ResolveLatest: false` for quick renders, reuses the existing source auth/proxy path. |
| `dotnet tool list` cannot prove restoration | Use global-packages-folder existence as a labelled best-effort check; confirm in step 4. |

## Out of scope

- Adding or removing tools, `dotnet new tool-manifest`.
- Tool vulnerability badges (feasible later with `NuGetVulnerabilityReader`; deferred).
- Global tools, `dnx`, `dotnet tool exec`.
- Consolidating the same tool across manifests (natural follow-up once read works).
