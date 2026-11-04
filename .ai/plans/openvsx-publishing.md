# Publish releases to Open VSX as well as the Marketplace

Status: IN PROGRESS
Created: 2026-11-04
Request: also release to open-vsx.org; GitHub trusted publisher already registered.

## Facts checked

- `ovsx@1.3.0` (latest) supports `publish <file> --trusted-publishing` and `--skip-duplicate`.
- `I-Synergy/nugetpackagemanager` already has an active version on Open VSX
  (`2026.11103.12325`), so the "first publication needs a PAT" precondition is satisfied.
- Trusted publishing needs `id-token: write`; a `--pat`/`OVSX_PAT` would take precedence and
  silently disable it.
- The registration matches owner + repo ID + workflow filename (`release.yml`), optionally a
  deployment environment. If an environment was pinned, the job must declare it.

## Changes

1. `.github/workflows/release.yml`
   - `permissions:` gains `id-token: write` (keep `contents: write`).
   - New step after the Marketplace publish:
     `npx --yes ovsx@1.3.0 publish "nugetpackagemanager-${VERSION}.vsix" --trusted-publishing --skip-duplicate`
   - Comment the environment caveat next to the job.
2. `docs/publishing.md` — retitle to both registries, add the Open VSX trusted-publishing setup
   (prerequisites, registration fields, no PAT, environment, first publish via PAT).
3. `README.md` → Releasing — mention both registries.
4. No `package.json`/lock change: the CLI is pinned inline (`ovsx@1.3.0`) so the quality gate's
   audit surface is unchanged.

## Verification

- Parse the workflow with the `yaml` package already in `node_modules`.
- `npx ovsx@1.3.0 publish --help` confirms the flag (done while planning).
- `git diff --check`; confirm no `OVSX_PAT` reference and `id-token: write` present.
- The actual OIDC exchange can only run in Actions on `main`; note that in the handoff.

## Steps

- [ ] Step 1: workflow step + permissions
- [ ] Step 2: docs and README
- [ ] Step 3: YAML validation and diff review
