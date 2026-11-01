# Plan: Toolchain-aware restore — honour `global.json`, classify SDK/workload failures, surface actionable errors

**Status:** IMPLEMENTED — 2026-10-31
**Date:** 2026-10-31
**Scope:** host process execution (SDK selection), structured dotnet failure classification,
a toolchain health RPC + diagnostics, and UI that explains the cause instead of dumping
raw MSBuild output.

## 1. Context

Observed on a real solution (`I-Synergy.Identity`):

```
error MSB4242: SDK Resolver Failure: ... WorkloadManifestCompositionException:
Workload pack 'Microsoft.NET.Runtime.Emscripten.Node.net10' in manifest
'microsoft.net.workload.emscripten.net10' (11.0.100-rc.3) conflicts with manifest
'microsoft.net.workload.emscripten.current' (10.0.100, 10.0.112)
```

Every project failed `dotnet restore`, so `batchUpdatePackages` rolled back 11 projects.
Three defects in this extension made that failure possible, or made it useless to the user:

1. **Wrong SDK is selected.** `TaskExecutor.ExecuteCommandAsync` spawns with
   `spawn(command, args)` and no `cwd` (`src/host/utilities/task-executor.ts:45`). The child
   inherits the extension-host working directory, and `dotnet` resolves `global.json` from
   the **current directory**, not from the project path in `argv`. The solution pins
   `10.0.403`; the extension silently ran `11.0.100-rc.3`.
   Reproduced: `cd $HOME && dotnet msbuild <csproj> -getProperty:TargetFramework` → MSB4242;
   same command from the project directory → `net10.0`.
2. **The same bug hides in framework resolution.**
   `ProjectFrameworkResolver.EvaluateWithMsBuildAsync` (`project-framework-resolver.ts:232`)
   also `execFile`s `dotnet msbuild` without `cwd`, and its failure path falls through to
   `{ Frameworks: [], Source: "xml" }` — so a broken toolchain silently degrades per-TFM
   version resolution instead of reporting anything.
3. **The UI cannot explain the failure.** `RestoreError` carries ~5 KB of raw dotnet output
   into a single-line `div` (`project-row .row-error`, `updates-view`, `cleanup-view`).
   There is no cause, no hint, no link to diagnostics, and nothing tells the user that the
   SDK — not their packages — is the problem.

Non-goals: repairing workloads, installing SDKs, or modifying `global.json`. The extension
reports and routes around a broken toolchain; it never mutates the machine.

## 2. Workstreams

### 2.1 SDK-correct process execution (core fix)

- `TaskExecutor.ExecuteCommandAsync(..., options?: { cwd?: string })` — optional options
  object appended to the signature; `spawn(command, args, { cwd, windowsHide: true })`.
- New `src/host/utilities/dotnet-context.ts`:
  - `resolveDotnetContextAsync(projectPath)` → `{ WorkingDirectory, GlobalJsonPath?, PinnedSdkVersion? }`
    by walking up from the project to the nearest `global.json` (stop at the workspace root
    or drive root), falling back to the project directory.
  - `readGlobalJsonAsync(globalJsonPath)` → parsed `sdk.version` / `rollForward` /
    `allowPrerelease`, tolerant of comments and BOM.
- Every `dotnet` invocation that operates on a project passes `cwd` from that context, and
  passes the project path as absolute with forward slashes (as today):
  - `restoreOneProjectAsync` / `restoreWithConflictResolutionAsync`,
    `updateProjectAsync`, `installPackageAsync`, `removePackageAsync`,
    vulnerability scan, `list package`, framework evaluation.
- Solution-wide operations stay per-project so each project honours its own `global.json`.
- `ProjectFrameworkResolver`: pass `cwd`; on failure, log a warning with the classification
  and record `EvaluationFailed` on `TargetFrameworkInfo` so callers can tell
  "XML fallback because toolchain is broken" from "XML only project".

### 2.2 Structured failure classification

- New `src/host/utilities/dotnet-failure.ts`:
  ```ts
  type DotnetFailureKind =
    | "WorkloadManifestConflict" | "SdkResolutionFailure" | "PinnedSdkMissing"
    | "RestoreConflict" | "SourceUnavailable" | "PasswordScriptFailed"
    | "DotnetMissing" | "Unknown";

  interface DotnetFailure {
    Kind: DotnetFailureKind;
    Summary: string;   // one line, user-facing
    Hint: string;      // what the user can do about it
    Detail: string;    // raw output, trimmed to the relevant lines
    SdkVersion?: string;
    GlobalJsonPath?: string;
    PinnedSdkVersion?: string;
    ProjectPath?: string;
  }
  ```
- `ClassifyDotnetFailure(output, context)` maps:
  - `MSB4242` + `WorkloadManifestCompositionException` → Summary names the SDK actually
    used, Hint suggests `dotnet workload update` / repairing or removing that SDK, and
    notes the project pins a different version when one is known.
  - `MSB4236` / "The SDK 'x' specified could not be found" → `PinnedSdkMissing`.
  - `NU1107` / `NU1605` → `RestoreConflict` (keeps the existing conflict parser).
  - ENOENT on `dotnet` → `DotnetMissing`.
- `DotnetError` gains `readonly failure?: DotnetFailure`, populated where the command is
  executed; `recordRestoreFailure` prefers `failure.Summary` over the truncated raw text so
  `RestoreError` in the RPC response is a sentence, with the raw output kept on the job
  record for the log/diagnostics view.

### 2.3 Toolchain health RPC + diagnostics

- `HostAPI.getToolchainHealthAsync()` (`src/common/rpc/types.ts` → `src/host/host-api.ts`):
  ```ts
  interface ToolchainHealth {
    DotnetFound: boolean;
    SdkVersion?: string;             // `dotnet --version` run with cwd = workspace root
    GlobalJsonPath?: string;         // nearest to the workspace root
    PinnedSdkVersion?: string;
    SdkMatchesPin?: boolean;
    SdkSelectionFails: boolean;      // smoke `dotnet msbuild -getProperty` on one project
    Issues: ToolchainIssue[];        // Kind/Summary/Hint/Detail
  }
  ```
  Cached per session keyed by `global.json` mtime; explicit `ForceRefresh` flag.
- `runDotnetDiagnosticsAsync(projectPaths)` — collects `dotnet --info`, `--list-sdks`, the
  nearest `global.json`, resolved SDK per project, and the last classified failure; writes
  to the existing output channel and copies a redacted report (no passwords, no feed
  credentials) to the clipboard.
- VS Code command `nugetPackageManager.copyToolchainDiagnostics` registered in
  `src/host/extension.ts`.

### 2.4 UI

- New `<actionable-error>` (`src/web/components/actionable-error.ts`):
  - `role="alert"`, title, one-line summary, hint line, actions
    (**Copy diagnostics**, **Show output**, **Retry**), and a collapsed
    `<details>` containing the raw output (first 40 lines + "Copy full output").
  - Props: `.failure`, `.onRetry`, `.onCopyDiagnostics`; no raw `innerHTML`.
- New `<toolchain-banner>` rendered by `packages-view` above the tab content when
  `getToolchainHealthAsync` reports issues: e.g.
  *"dotnet 11.0.100-rc.3 is selected, but this solution pins 10.0.403 in global.json —
  SDK resolution fails"* with **Re-check** and **Copy diagnostics**. Dismissible per
  session only (not persisted).
- Replace the one-line error divs with `<actionable-error>` in `project-row`,
  `updates-view`, `cleanup-view`, `consolidate-view`, `vulnerabilities-view`.
- `settings-view`: new "Toolchain" section showing dotnet/SDK/pin status and the
  **Copy diagnostics** action.

### 2.5 Tests

- Host:
  - `task-executor.test.ts` — stub `spawn`, assert `cwd` is forwarded and absent when not
    supplied (no behaviour change for callers that do not pass it).
  - new `dotnet-context.test.ts` — nearest `global.json` from nested project, none found,
    workspace-root boundary, malformed file.
  - new `dotnet-failure.test.ts` — the exact MSB4242 text from this report classifies as
    `WorkloadManifestConflict` with both SDK versions and a hint; NU1107 still maps to
    `RestoreConflict`; unknown output degrades to `Unknown`.
  - `project-framework-resolver.test.ts` — evaluation failure is reported, not silently
    treated as an XML-only project.
- Web:
  - `actionable-error.test.ts` — renders summary/hint, expands raw output, fires retry and
    copy actions.
  - `toolchain-banner` / `updates-view` test — structured failure wins over raw text;
    banner appears when health reports issues and re-checks on click.

### 2.6 Docs

- `README.md`: short *Troubleshooting → SDK and workload errors* section (what the banner
  means, how to read diagnostics).
- `CHANGELOG.md`: user-visible entry under Unreleased.

## 3. Risks and decisions

| Decision | Effect | Mitigation |
|---|---|---|
| Passing `cwd` changes the selected SDK | Projects with `global.json` now build with their pinned SDK; restore errors may change | Intended; `PinnedSdkMissing` classification gives an actionable message |
| Solution-wide batch across mixed pins | One process per project (already the case for restore) | No change to job/progress semantics |
| Health check costs one extra `dotnet --version` + one smoke msbuild | ~2–4 s once per session | Cached; smoke test skipped when `dotnet` is missing |
| Remote/WSL/SSH workspaces | `global.json` lookup uses the extension host file system | Documented in README; no silent behaviour change |
| Raw output still needed | Truncating the RPC error could hide detail | `Detail` kept on the job record, surfaced via diagnostics and `<details>` |

## 4. Verification

1. `npm run esbuild` and `npm run lint` clean.
2. Focused tests: `task-executor`, `dotnet-context`, `dotnet-failure`,
   `project-framework-resolver`, `actionable-error`, `updates-view`.
3. Full `npm test` (multi-file change).
4. Manual: with `cwd` = project directory the MSB4242 case resolves to `net10.0`;
   with the broken SDK selected the UI shows the summary + hint and the raw output is
   collapsed behind **Show output**.
