# Packaging a VS Code extension that ships a .NET sidecar

Everything here is specific to VS Code extensions: the VSIX is the deliverable, `vsce` walks the
folder, and the extension knows its own path at runtime.

## 1. Where the sidecar lives

`context.extensionPath` points at the unpacked extension root. Publish into `dist/core` so both the
development (F5) and installed layouts resolve identically:

```json
"build:core": "dotnet publish src/App.Core/App.Core.csproj -c Release -o dist/core",
"vscode:prepublish": "node ./esbuild.js && npm run build:core"
```

```ts
coreProcess.Configure(context.extensionPath);   // → <extensionPath>/dist/core/App.Core.dll
```

`vscode:prepublish` is the hook `vsce package` and `vsce publish` run. Without it the VSIX ships
whatever stale `dist/core` happens to exist.

## 2. Publish mode (measured, not guessed)

Reference measurement: 12 interleaved cold starts, Windows 11 arm64, .NET SDK 11.0.100-rc.3.

| Variant | Output | Cold start (median) | Portable across OS/arch |
|---|---|---|---|
| framework-dependent IL (**choose this**) | 4.4 MB, 21 files | 67 ms | yes — any OS/arch with .NET 8+ |
| `PublishReadyToRun -r <rid> --self-contained false` | 11 MB, 20 files | 67 ms | no — per RID |
| `PublishTrimmed -r <rid> --self-contained true` | 29 MB, 95 files | does not start | no — per RID |

- **R2R buys nothing** here: startup is dominated by the `dotnet` host and assembly loading, not by
  JIT of your code.
- **Trimming breaks `System.Text.Json`** with reflection serialization
  (`JsonSerializer.IsReflectionEnabledByDefault=false`). The protocol serializes anonymous handler
  payloads, so the process starts and then fails on the first response. Fixing it means
  source-generated JSON plus named DTOs for every handler — a large change for a packaging win.
- **Per-RID output forces per-platform packaging.** A single VSIX cannot contain one core per RID
  cheaply (~66 MB for one R2R core across three platforms). Use `vsce package --target` per platform
  only if startup has been measured as a real problem.

`UseAppHost=false` in the csproj keeps the output a plain `.dll` launched as `dotnet App.Core.dll`,
with no per-OS launcher binary.

## 3. Runtime prerequisites

The sidecar targets `net8.0` with `RollForward=LatestMajor`: it runs on 8.x or newer, including
preview runtimes. The machine still needs the **.NET runtime and the `dotnet` CLI on `PATH`** — the
extension shells out to `dotnet` for other work anyway.

- Resolve the failed state as `CoreError("unavailable", "<actionable message>")`; never throw at
  activation.
- Offer a settings-driven path if your extension already lets users point at a private SDK install.
- Do not bundle a runtime unless you accept the per-RID packaging cost above.

## 4. VSIX contents

- `dist/core/**` must be included. Check `.vscodeignore`: a broad `dist/**` exclusion or a `*.dll`
  rule silently drops it.
- Exclude C# `bin/`, `obj/` and the source projects; only the publish output belongs in the VSIX.
- Size guideline: keep the extension under the marketplace's per-file limits by shipping the
  framework-dependent core (4–5 MB), not a self-contained one.
- Verify by unzipping the produced `.vsix` and looking for `extension/dist/core/App.Core.dll`.

## 5. Activation and deactivation

- Configure the client during `activate(context)`, push the disposable into
  `context.subscriptions`.
- Start the process lazily on the first sidecar call, not during activation, so startup stays fast.
- On `deactivate`, call `Dispose()` — it ends stdin and kills the child. VS Code does not always
  wait for async deactivation, so do the kill synchronously.
- Never leave a `dotnet` process behind on reload; check Task Manager after a few reloads.

## 6. Feature flag and cutover

```jsonc
// package.json contributes.configuration
"myExtension.useCore": {
  "type": "boolean",
  "default": false,
  "description": "Use the .NET sidecar implementation (temporary migration switch)."
}
```

1. Flag defaults **off**; both paths exist for exactly one wave.
2. Parity harness green on shared fixtures.
3. Flip default, run the full quality gate, delete the TypeScript twin and its tests in that PR.
4. Remove the flag in a follow-up once nothing reads it — a dead switch is a future bug.

Rollback plan before flipping: the flag itself, plus the fact that the previous implementation is
still in the tag you branched from. Do not keep dead code "just in case".

## 7. CI

- Install the .NET SDK in the pipeline; run `dotnet build` and `dotnet test` before packaging.
- The quality gate should build the core, test both languages and package the VSIX.
- If the SDK is absent, make the gate **skip the core steps with a loud warning** rather than pass
  silently — a green pipeline that never built the sidecar is worse than a red one.
- E2E that launches the real sidecar needs the real `dotnet` CLI on `PATH`; keep it opt-in
  (`npm run test:e2e`) so unit runs stay fast and deterministic.

## 8. Versioning

Keep the sidecar version independent from the extension version in the assembly, but log both at
startup (the handshake carries `version`) so a bug report identifies the exact core build.
