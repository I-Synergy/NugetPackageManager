# Publish releases to Open VSX
Status: DONE
Started: 2026-11-04
Plan: `.ai/plans/openvsx-publishing.md`

## Steps
- [x] Step 1: workflow step + permissions
- [x] Step 2: docs and README
- [x] Step 3: YAML validation and diff review

## Notes

- `.github/workflows/release.yml`: workflow-level `permissions` now includes `id-token: write`;
  a "Publish to Open VSX" step runs after the Marketplace publish:
  `npx --yes ovsx@1.3.0 publish "nugetpackagemanager-${VERSION}.vsix" --trusted-publishing --skip-duplicate`.
  No token secret, no `OVSX_PAT`/`--pat` (either would take precedence and disable trusted
  publishing). A job comment records the registration fields and the environment caveat.
- `docs/publishing.md` now documents both registries, the trusted-publisher registration
  (owner/repo/workflow + optional environment), the no-PAT rule, and PAT-based manual publishing.
- `README.md` → Releasing mentions both registries.
- No `package.json`/lockfile change: the CLI is pinned inline as `ovsx@1.3.0`.

### Verification
- Parsed the workflow with the repo's `yaml` package: permissions
  `{contents: write, id-token: write}`, step order Marketplace → Open VSX → release notes, guard
  `steps.check.outputs.skip != 'true'`, and no `OVSX_PAT`/`--pat` reference.
- `npx ovsx@1.3.0 publish --help` confirms `--trusted-publishing` and `--skip-duplicate`.
- `git diff --check` clean.
- The OIDC exchange itself can only be exercised by a release run on `main`. If the trusted-publisher
  registration pins a deployment environment, add the same `environment:` to the `release` job.
