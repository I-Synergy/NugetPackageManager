# SDK selector and SDK installer

**Status:** DONE
Started: 2026-10-31
Completed: 2026-10-31
Follow-up to: `.ai/plans/toolchain-sdk-diagnostics.md`

## What was added

- `nugetpackagemanager.dotnetSdkVersion` (resource scope, empty = automatic).
  The override is applied by running `dotnet` in a generated
  `<globalStorage>/sdk-pins/<version>/global.json` directory; the repository's
  `global.json` is never written.
- `sdk-override.ts` — override state, generated pin directory, private host
  selection (`~/.dotnet`), SDK listing/version comparison.
- `sdk-install.ts` — downloads Microsoft's `dotnet-install` script over HTTPS and
  installs into the user's `~/.dotnet`. Guarded by a trusted workspace, an explicit
  confirmation dialog, and a strict version pattern; the script is deleted after use.
- RPC: `setSdkOverrideAsync`, `installSdkAsync`; `ToolchainHealth` now reports
  `InstalledSdks`, `SdkOverrideVersion` and `DotnetPath`.
- UI: `<sdk-select>` (Automatic + installed SDKs + "Install <version>" when the pin is
  missing) inside `<toolchain-banner>` and *Settings → dotnet toolchain*.
- `TaskExecutor` resolves the executable from the SDK context, so every dotnet call
  uses the private host when it holds the selected SDK.
- Install auto-selects the installed version for the workspace and re-checks health.

## Toolchain tab (follow-up request)

- `toolchain-view.ts` — full tab: dotnet host, selected SDK, `global.json` pin, workspace
  override, pin match, project-evaluation state, installed SDKs, per-issue cause + hint with
  collapsible raw output, **Re-check**, **Copy diagnostics**, and the `sdk-select`.
- Added `"toolchain"` to `TabId` as the last tab (after Vulnerabilities), with an issue-count
  badge fed by `count-changed`; keyboard tab navigation (`End`) now lands on it; the old
  "Cleanup is last" test was updated.

## Workload maintenance + global.json pinning

## Re-check progress

`toolchain-view` and `toolchain-banner` render an indeterminate progress bar (plus a spinner
label) while `getToolchainHealthAsync` is in flight, disable **Re-check**, keep the previous
result on screen, and honour `prefers-reduced-motion`. The banner previously unmounted on
re-check because it required `TaskStatus.COMPLETE`.

## Pin lives in global.json (follow-up request)

- Removed `nugetpackagemanager.dotnetSdkVersion` and the generated pin directory.
- `global-json.ts` writes `sdk.version` into the nearest `global.json` (surgical replace; comments,
  key order and unrelated sections preserved; created at the workspace root when missing; verified
  by re-parsing, canonical rewrite only as a fallback).
- `setWorkspaceSdkAsync` replaces `setSdkOverrideAsync`; `installSdkAsync` pins the installed SDK in
  `global.json`; `sdk-override.ts` was replaced by `sdk-locations.ts` (host selection + listing only).
- Workload actions: `runWorkloadCommandAsync` runs `dotnet workload update|repair` in the selected SDK
  context (trusted workspace, confirmation, 15 min timeout), reports output and detects elevation
  failures; the Toolchain tab shows the buttons and automatically re-checks after success.

## Coherent global.json updates

`UpdateGlobalJsonSdkVersion` now updates the whole pin, not just `sdk.version`:
`rollForward` is set to `disable` (exact pin, same as the manual fix the user applied),
`allowPrerelease` is set for prerelease SDKs, `workloadVersion` is removed when it targets a
different feature band, `tools.dotnet` follows the pin — each reported in `Notes` and shown by
the selector. The probe also detects orphaned `sdk-manifests/<band>` folders (manifests left
behind by an uninstalled SDK) and names them in the workload-conflict hint; verified on this
machine: band `10.0.100` has no installed SDK and its `emscripten.current` (10.0.112) is what
collides with the 11 RC band.

## Official .NET mechanisms

- Probe reads `NETCoreSdkVersion` from the same `dotnet msbuild -getProperty` call and reports it
  as `BuildSdkVersion`; a mismatch with `dotnet --version` is an `SdkSelectionMismatch` issue.
- `dotnet sdk check` (`sdk-check.ts`) supplies `SdkStatus` per selected SDK; cached per host +
  working directory (10 min, 60 s when unavailable), bypassed by Re-check, `Unavailable` offline.
- A missing `global.json` is created with `dotnet new globaljson --sdk-version <v> --roll-forward
  disable`; existing files still use the surgical writer, which is also the fallback.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run lint` — 0 errors, 8 warnings (complexity/regex advisories).
- `npx vscode-test` — 503 passing, exit 0 (baseline before this slice: 460).
- `npm run esbuild` — build complete.
