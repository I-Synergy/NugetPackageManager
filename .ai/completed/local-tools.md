# Local .NET Tools — detect, version-update and health
Status: DONE
Started: 2026-11-03

Plan: `.ai/plans/local-tools.md`

## Steps
- [x] Step 1: contract types + core handlers wired in Program.cs
- [x] Step 2: locator + reader + writer in Core.Workspace/Tools with MSTest fixtures
- [x] Step 3: outdated resolver + readLocalTools/updateLocalTool handlers + toolchain findings
- [x] Step 4: host local-tools adapter, HostAPI methods, health merge
- [x] Step 5: "Repo tools" card in toolchain-view + component tests
- [x] Step 6: diagnostics report + README/CHANGELOG
- [x] Step 7: quality gate, relevant tests, move to .ai/completed

## Notes

### What shipped
- **Core** (`Core.Workspace/Tools`): `LocalToolManifestLocator` (walks project/workspace
  directories up to the workspace root, skips `bin`/`obj`/`node_modules`/`.git`, dedupes by real
  path), `LocalToolManifestReader` (version, `isRoot`, per-tool `version`/`commands`/`rollForward`,
  problems for malformed JSON and duplicate commands), `LocalToolManifestWriter` (validates the
  whole document first, edits only the target tool's `version` bytes, verifies every other field is
  unchanged, refuses on `ExpectedVersion` mismatch or a changed file, preserves BOM/CRLF/unknown
  fields), `LocalToolOutdatedResolver` (highest eligible version, never a downgrade, prerelease only
  on request).
- **Core handlers**: `readLocalTools`, `updateLocalTool` (path must resolve inside a workspace root
  and be named `dotnet-tools.json`; never spawns `dotnet`). `evaluateToolchain` accepts an optional
  `localTools` slice and emits `LocalToolManifestInvalid` / `LocalToolNotRestored`; health gains
  `LocalToolManifests` / `LocalToolsNotRestored`.
- **Host**: `utilities/local-tools.ts` (`ReadLocalToolsAsync` resolves an empty `WorkspaceRoots`
  from the open folders, resolves NuGet sources only when latest versions are requested, fills
  `NotRestored` from the global packages folder; `UpdateLocalToolAsync` validates the path, writes
  the manifest, then runs `dotnet tool restore` with cwd = the manifest directory and reports a
  failed/timed-out restore without rolling back). `HostAPI` gains `getLocalToolsAsync` /
  `updateLocalToolAsync`; `getToolchainHealthAsync` merges the local-tool health slice with
  `ResolveLatest: false` (no network on the health path). The diagnostics report gains a
  `--- local tools ---` section (manifests, tools, pins, restore state), still redacted.
- **Webview**: "Repo tools" card in `toolchain-view` — one group per manifest with a relative path,
  per-tool rows (commands first, id second, `current → latest`, pinned badge), per-row **Update**
  with per-row status, manifest problem warnings, empty state. No "update all". Refreshes on
  Re-check, never touches the workspace snapshot.
- **Docs**: README Toolchain section + feature table, CHANGELOG entry.

### Decisions recorded during implementation
- The restore probe is the global packages folder (`NUGET_PACKAGES` or `~/.nuget/packages`,
  lower-cased id + manifest version) and is labelled best effort: an unreadable folder reports
  "not missing" rather than claiming every tool needs a restore. `dotnet tool list --local` cannot
  prove a tool was downloaded, so it was not used.
- A malformed manifest is now rejected as `invalidManifest` before the byte-range scan: the reader
  used to stop at the target tool's version and only later fail verification, which reported
  `verificationFailed`.
- The webview cannot know workspace folders, so it sends `WorkspaceRoots: []`; the host resolves
  them. The card's relative manifest path is inferred from the common prefix of `projectPaths`, so
  a single-project repo shows the project folder rather than the true root (absolute path is the
  fallback).
- `dotnet tool restore` after an update is bounded by its own 120 s timeout and is not tied to the
  RPC `AbortSignal`; the manifest write is already durable at that point.

### Verification
- `dotnet build NugetPackageManager.slnx -c Release` — success (0 warnings, 0 errors).
- `dotnet test` — 57 (`Core.NuGet`), 108 (`Core`), 222 (`Core.Workspace`) passed.
- `npm run typecheck`, `npm run lint` — clean.
- Focused suites: `local-tools.test.js` (24), `toolchain-health.test.js` (6),
  `toolchain-view.test.js` (16) passed.
- `npm run quality` — **PASS, 8/8 steps** (Build, Lint + SonarJS, Type check, C# build, C# tests,
  Compile tests, Tests 522 passing, Dependency audit).
