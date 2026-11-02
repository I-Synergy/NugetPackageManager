# Architecture and transport

## Process model

```
┌─ VS Code extension host (Node) ──────────────┐      ┌─ sidecar (dotnet App.dll) ─┐
│ activation → CoreProcess.Configure(path)     │      │ Program.cs: wire handlers  │
│ host-api handlers → CoreProcess.CallAsync    │      │ NdjsonServer.RunAsync      │
│ CoreClient: spawn / ids / timers / restarts  │◄────►│ line in → handler → line   │
│ webview RPC (postMessage) unchanged          │ stdio│ stderr = diagnostics only  │
└──────────────────────────────────────────────┘      └────────────────────────────┘
```

- One sidecar per extension host, started lazily, disposed on deactivate.
- stdin/stdout carry protocol lines only. Any human-readable log goes to **stderr**, which the
  host forwards to its output channel. A stray `Console.WriteLine` corrupts the protocol.
- The sidecar never knows about `vscode`. Anything editor-specific (settings, proxy, trust,
  workspace path validation) arrives as request parameters.

## Wire shapes

Request:

```json
{"id": 7, "method": "getProjects", "params": {"projectPaths": ["..."]}}
```

Success:

```json
{"id": 7, "ok": true, "value": { ... }}
```

Failure:

```json
{"id": 7, "ok": false, "error": {"code": "invalidParams", "message": "..."}}
```

Handshake, written before the read loop:

```json
{"ready": true, "protocol": 1, "version": "2.3.0.0"}
```

Built-ins handled by the server: `ping` → `{pong:true, protocol}`; `cancel` with
`{target: <id>}` → cancels the linked token of that request and answers `{cancelled: <id>}`.
A cancel for an unknown or already-finished id is a success, not an error — the race is normal.

## Concurrency

- Requests are read in a loop and each runs as its own task; responses are matched by `id`.
- Writes are serialized behind one `SemaphoreSlim` so two handlers cannot interleave a line.
- Long-running work must be cancellable: create a linked `CancellationTokenSource` per request,
  store it by id, remove it in `finally`.
- Do not assume ordering. If two operations mutate the same file, serialize on the host (or in
  one handler) — the transport does not.

## Error model

| Code | Meaning | Host action |
|---|---|---|
| `unavailable` | dll missing, `dotnet` absent, start failed | show actionable message; do not retry in a loop |
| `crashed` | process exited mid-flight | reject pending calls; bounded restart on next call |
| `timeout` | host deadline elapsed | detach; the work may still finish |
| `cancelled` | cancellation requested or observed | treat as a user action, not an error |
| `invalidRequest` / `unknownMethod` / `invalidParams` | client bug | surface as an internal error |
| `internalError` | unhandled exception in a handler | log the stderr stack; generic message to the user |

Domain codes (e.g. `notFound`, `writeConflict`) are part of the contract. Enumerate them in one
place on both sides; do not let ad-hoc strings leak into user-facing text.

## Host client lifecycle

```ts
CallAsync(method, params, signal?)   // lazy start → id → write → await response
Notify(method, params)               // fire-and-forget; failures logged
IsRunning                            // for status display
Dispose()                            // deactivate: end stdin, kill
```

Details that matter, all learned the hard way:

- **Single-flight start.** Keep a `starting` promise; concurrent first calls must await the same
  handshake.
- **Handshake timeout.** Reject with `unavailable` and kill the child; otherwise activation hangs.
- **Deadline detaches.** On timeout reject the caller with `timeout` but leave the request
  running. Send `cancel` only when the caller's `AbortSignal` fires. Conflating the two produces
  "the UI says failed but the file was written".
- **Bounded restarts.** Count consecutive failures without a successful response; after N, stop
  and report `unavailable`. Reset the counter on any successful response.
- **Kill on start failure.** A child that never announced readiness must not linger.
- **Ignore late responses** for ids already settled.
- **Buffer stdout across chunks.** Lines can split; keep a string buffer and split on `\n`.

## Result<T> at the host boundary

Every host method returns `{ ok: true, value } | { ok: false, error }`. Convert `CoreError` into
`fail(error.message)` at the boundary and never let an exception escape into the webview RPC. The
webview should not know whether the answer came from TypeScript or .NET.

## Security boundary

- Validate project/file paths on the **host** before sending them (resolve + realpath + relative
  check), and validate URLs with `new URL()` before they reach the sidecar.
- Read the proxy and credentials in the host (VS Code settings + secret storage) and pass them as
  parameters; never let the sidecar read editor configuration.
- Script execution, workspace trust and settings-derived allowlists stay on the host.
- The sidecar can assume its inputs are already validated, but should still fail closed on
  malformed JSON.

## Testing the transport without .NET

Write a **fake sidecar** in Node: a tiny script that reads stdin lines and answers as configured
(including ready, errors, crashes and slow responses). That is how the reference client got its
coverage — start/timeout/cancel/restart/dispose — without launching `dotnet`. Keep one real E2E
that does launch it.

## Telemetry and logging

- Sidecar: stderr lines, prefixed by level; no PII.
- Host: forward stderr into the extension's output channel; record latency per method if the
  extension already has telemetry.
- Never log request payloads at info level — they contain paths and possibly credentials.
