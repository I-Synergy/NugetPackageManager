# Probing a sidecar: transport, warmup, RSS

## Know the framing before writing the probe

Read the transport module first. Two shapes dominate:

| Framing | Request | Response | Ready signal |
|---|---|---|---|
| NDJSON (one JSON object per line) | `{"id":1,"method":"x","params":{}}\n` | `{"id":1,"ok":true,"value":...}` | `{"ready":true}` |
| LSP-style | `Content-Length: N\r\n\r\n<body>` | same framing, `id` echo | `initialize` handshake |

Adapt `scripts/sidecar-probe.mjs` to the second shape by buffering on `Content-Length` instead of
`\n`. Everything else — readiness, sampling, burst, payload capture — stays the same.

Minimal NDJSON probe skeleton:

```js
const child = spawn("dotnet", [dll], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const msg = JSON.parse(line);              // ignore unparsable lines (stderr/log noise)
  if (msg.ready === true) return resolveReady();
  pending.get(msg.id)?.(msg);
});
child.stdin.write(`${JSON.stringify({ id: ++n, method, params })}\n`);
```

Rules that matter:

- **Wait for the ready line** before the first call; otherwise you time the handshake as latency.
- **Ignore the first call** when reporting steady-state latency — tiered JIT and cold caches make
  it 5–10× the rest.
- **Never spawn a sidecar per iteration.** One process, many calls; otherwise you measure
  `dotnet` host startup (~90 ms) instead of the operation.
- **Capture a real response payload to disk** and feed it to the host-side decode benchmark. A
  hand-written object will not reproduce string lengths, key ordering, or numeric shapes.

## Reading RSS of another process on Windows

Node cannot read a child's RSS portably. Use PowerShell for the PID:

```js
import { execFileSync } from "node:child_process";
const rssOf = (pid) =>
  Number(execFileSync("powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`],
    { encoding: "utf8" }).trim());
```

Sampling costs ~80–150 ms per call, so sample every 10th request, not every request.
Alternatives: `tasklist` (no memory column), `wmic` (deprecated), or a `Process` handle inside the
sidecar itself if you may modify it (you usually may not, and should not for a measurement task).

## Burst test: plateau vs leak

Run 200+ calls with sampling every 10:

- RSS rises, then falls back when GC runs → GC heap utilisation. Report "plateaus".
- RSS rises monotonically with no recovery → investigate before publishing a footprint number.
- RSS is independent of input size (a tiny input still pushes the process to ~45 MiB) → the cost
  is the runtime plus per-request garbage, not the document. Say that explicitly; it changes the
  recommendation (it will not shrink with smaller projects).

## Process hygiene

```js
child.stdin.end();
child.kill();       // and, on POSIX, kill the process group if you spawned a shell wrapper
```

On Windows, a probe that exits without killing the child leaves `dotnet` running and skews the
next run's idle baseline. Kill explicitly.

## Timing boundaries

Include in per-call latency: request write → response parsed.
Exclude: process spawn, ready handshake, file-system warmup of the measured file (read once
before the loop), and PowerShell RSS sampling (do it between calls and subtract nothing — just
keep it off the hot path).
