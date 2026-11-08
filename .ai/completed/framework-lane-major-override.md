# Framework lanes in multi-.NET workspaces

Status: DONE
Started: 2026-11-08
Completed: 2026-11-08
Plan: `.ai/plans/framework-lane-major-override.md`

## Steps

- [x] Add `allowMajorVersionOverride` setting and configuration plumbing
- [x] Host: strict framework lanes in the outdated scan
- [x] Host: lane-aware recommended version for installed rows (`getPackageAsync`)
- [x] Webview: pass row framework context from the Installed list
- [x] Webview: settings toggle and Updates banner
- [x] Tests: host lane rules and `getPackageAsync` recommendation
- [x] Tests: settings-view and packages-view
- [x] Docs: README and CHANGELOG
- [x] Verification: typecheck, lint, focused tests (`npm test`): 536 passing
- [x] Package a local VSIX into `releases/`

## Notes

- User-confirmed semantics: strict lanes only when the scope targets more than one .NET major;
  single-major scopes keep the existing cross-major behaviour.
- Shared rows use the lowest major carrying them.
- `nugetpackagemanager.allowMajorVersionOverride` defaults to `false` and restores the explicit
  cross-major escape hatch when enabled.
