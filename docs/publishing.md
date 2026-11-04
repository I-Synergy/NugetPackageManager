# Publishing to VS Code Marketplace and Open VSX

Every release is published to both registries from the same `.vsix`.

## Prerequisites

### VS Code Marketplace

1. Create a publisher on [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) (publisher ID: `I-Synergy`)
2. Generate a Personal Access Token (PAT) in [Azure DevOps](https://dev.azure.com/) with **Marketplace > Manage** scope
3. Add the PAT as a repository secret named `VSCE_PAT` (Settings > Secrets > Actions)
4. Optional: add `RELEASE_TOKEN` when the default `GITHUB_TOKEN` cannot push tags or create releases

### Open VSX (trusted publishing, no secret)

Open VSX understands a GitHub Actions OIDC identity, so no publishing token is stored.
Before the first trusted release:

1. The `I-Synergy` namespace must be verified and owned on [open-vsx.org](https://open-vsx.org)
   (the extension must already have an active version — the very first publication needs a PAT).
2. Register the workflow under **Settings → Trusted Publishers**: owner `I-Synergy`, repository
   `NugetPackageManager`, workflow filename `release.yml`, and environment `production`.
3. Do **not** add an `OVSX_PAT` secret or pass `--pat`. A token takes precedence and would silently
   disable trusted publishing.

The release job runs in the GitHub environment `production`, which is restricted to the `main`
branch: a feature branch cannot reach the publishing steps even if it runs this workflow. The
Open VSX registration must name that same environment, otherwise the OIDC token's environment
claim does not match and the exchange is rejected. Registrations cannot be edited — delete and
recreate yours if it was registered without an environment.

Trusted publishing is bound to the repository ID and the workflow filename, not to a branch or
tag. Anyone who can change `release.yml` can publish — keep branch protection and workflow review
in place.

## Automatic versioning

Versions are **not bumped by hand** — the same scheme as the I-Synergy/AI repo.
Every push to `main` runs `.github/workflows/release.yml`, which:

1. derives a UTC build number in the form `YYYY.1MMdd.1HHmm` (for example `2026.11030.1425`),
2. skips the run when the tag already exists,
3. sets that version in `package.json` for the run only (`npm version … --no-git-tag-version`),
4. runs the quality gate, packages the `.vsix`, publishes it to the Marketplace and to Open VSX
   (`npx ovsx@1.3.0 publish … --trusted-publishing --skip-duplicate`),
5. creates an annotated tag named after the build number (**no `v` prefix**) and a
   GitHub Release whose notes are generated from the commits since the previous tag.

`package.json` in the repository keeps its last published version; the release
workflow overrides it at build time. `main` is never modified, and no changelog or
release-notes file is committed.

To force a specific build (for example a retry), run **Actions > Release > Run workflow**
and pass `YYYY.1MMdd.1HHmm` as the build number.

## Quality gate

`release.yml` runs `npm run quality` before packaging. The same checks also run on every
push and pull request in `.github/workflows/quality-gate.yml`:

```bash
npm run quality            # build, lint (ESLint + SonarJS), type check, tests, npm audit
npm run quality:coverage   # same, and writes coverage/lcov.info
```

SonarCloud analysis is performed by its GitHub integration (automatic analysis); no
scanner or `SONAR_TOKEN` is required.

## Manual publish

A manual publish is possible but bypasses the automatic version. Trusted publishing only works
from the registered GitHub Actions workflow, so a manual release uses a personal access token.

```bash
npm run package                                     # builds releases/nugetpackagemanager-x.x.x.vsix

# VS Code Marketplace
npx @vscode/vsce login I-Synergy                     # authenticate with the VSCE_PAT
npx @vscode/vsce publish --no-dependencies

# Open VSX (create a PAT under open-vsx.org → User Settings → Tokens)
npx ovsx@1.3.0 publish releases/nugetpackagemanager-x.x.x.vsix --pat <open-vsx-token>
```
