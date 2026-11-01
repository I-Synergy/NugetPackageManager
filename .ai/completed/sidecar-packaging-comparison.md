# Sidecar Packaging Comparison

Status: DONE — decision: keep the universal framework-dependent build
Started: 2026-11-01

## Steps
- [x] Step 1: baseline publish + timing
- [x] Step 2: R2R publish + timing + functional check
- [x] Step 3: trimmed publish + timing + functional check
- [ ] Step 4: source-generation fixes if trimming needs them
- [ ] Step 5: package 2.2.1-r2r and 2.2.1-trim
- [x] Step 6: restore package.json, record results

## Results (win-arm64, .NET SDK 11.0.100-rc.3, 12 interleaved cold starts each)

| Variant | Core output | Cold start (median) | Launch | Portable? |
|---|---|---|---|---|
| baseline (today) | 4.4 MB, 21 files | 67 ms | `dotnet <dll>` | yes — any OS/arch with .NET 8+ |
| `PublishReadyToRun` (`-r win-arm64 --self-contained false`) | 11 MB, 20 files | 67 ms | `dotnet <dll>` | no — per-RID |
| `PublishTrimmed` (`-r win-arm64 --self-contained true`) | 29 MB, 95 files | n/a | apphost `.exe` | no — per-RID |

- R2R is 2.5x the size and **no faster**: startup is dominated by the `dotnet` host and assembly
  loading, not JIT of our code.
- Trimmed output does not start: the trim pipeline sets
  `System.Text.Json.JsonSerializer.IsReflectionEnabledByDefault=false`, and the protocol serializes
  anonymous handler payloads (`NdjsonServer.WriteAsync(object)`). Making it run needs source-generated
  JSON for the protocol plus named DTOs for every handler response; even then it is 6.6x the baseline
  and still per-RID.
- `-p:JsonSerializerIsReflectionEnabledByDefault=true` on the command line did not reach
  `runtimeconfig.json`; the reflection switch cannot be turned back on from MSBuild alone.
- Earlier single runs (61 vs 70 ms, 99 vs 66 ms) were noise; the interleaved medians are identical.

## Consequence for macOS

Every R2R and trimmed build is RID-specific. Supporting Windows + macOS (and Linux) would mean either
one core per RID inside the VSIX (R2R: roughly 66 MB) or per-platform VSIXes via
`vsce package --target`. The current framework-dependent IL build is the only packaging that ships as
one universal VSIX, and the machine used for these numbers is Windows on ARM (`win-arm64`).

## Notes

Both variants were published under `$TMPDIR`; the repo, `dist/core` and `package.json` are untouched.
