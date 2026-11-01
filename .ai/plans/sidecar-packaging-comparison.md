# Plan: ReadyToRun vs trimmed sidecar — measure, then ship both

Status: CLOSED 2026-11-01 — measured, recommendation accepted: keep the universal framework-dependent build. Results in `.ai/completed/sidecar-packaging-comparison.md`.

## Question

Which packaging of the C# sidecar is smaller and starts faster: `PublishReadyToRun` (framework-dependent,
same `dotnet <dll>` launch) or `PublishTrimmed` (trimming requires a self-contained publish, so a
different launch path), compared with today's plain IL build?

## Method

1. Publish three variants to `$TMPDIR` (no repo churn):
   - `baseline` — current `dotnet publish -c Release -o dist/core` output.
   - `r2r` — `-r win-x64 --self-contained false -p:PublishReadyToRun=true`.
   - `trim` — `-r win-x64 --self-contained true -p:PublishTrimmed=true`.
2. Measure each with the same NDJSON harness: time spawn → `{"ready":true}` handshake, then a `ping`
   round trip and a `getProjects` call over the four fixture projects. 5 runs, report median.
3. Verify functional equivalence: compare the `getProjects` JSON of each variant with the baseline.
4. If trimming needs JSON source generation, add `JsonSerializerContext` for the protocol and
   `AssetsDocument` rather than disabling analyzers.
5. Package the variants that are functional and worth testing:
   - `2.2.1-r2r` — R2R core.
   - `2.2.1-trim` — trimmed self-contained core, which needs `core-process.ts` to prefer
     `dist/core/NugetPackageManager.Core.exe` when present.
6. Restore `package.json` to `2.2.0` afterwards (versions are never bumped by hand in this repo;
   the suffixes exist only for the local test artifacts).

## Risks

- Trimming removes anonymous handler payloads' properties silently → must be caught by comparing
  real `getProjects` output, not just by a successful build.
- Self-contained/trimmed output is per-RID, so any such VSIX is Windows-only.
- `vsce package` runs `vscode:prepublish`, which would overwrite `dist/core`; the variant builds must
  bypass that hook for packaging.
