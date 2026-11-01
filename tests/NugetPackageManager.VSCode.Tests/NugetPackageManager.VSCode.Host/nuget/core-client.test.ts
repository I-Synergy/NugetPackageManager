import * as assert from "node:assert";
import { CoreClient, CoreError, type CoreClientOptions } from "@/host/nuget/core-client";

/**
 * Fake sidecar: a Node script that speaks the same NDJSON protocol.
 * Tests never launch the real .NET process.
 */
const FakeSidecar = String.raw`
process.stdin.setEncoding("utf8");
process.stdout.write(JSON.stringify({ ready: true, protocol: 1, version: "test" }) + "\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      handle(JSON.parse(line));
    }
    index = buffer.indexOf("\n");
  }
});
function handle(request) {
  if (request.method === "ping") {
    reply({ id: request.id, ok: true, value: { pong: true } });
    return;
  }
  if (request.method === "cancel") {
    process.stderr.write("cancel:" + request.params.target + "\n");
    reply({ id: request.id, ok: true, value: { cancelled: request.params.target } });
    return;
  }
  if (request.method === "hang") {
    return;
  }
  if (request.method === "crash") {
    process.exit(3);
  }
  if (request.method === "deny") {
    reply({ id: request.id, ok: false, error: { code: "unauthorized", message: "nope" } });
    return;
  }
  reply({ id: request.id, ok: false, error: { code: "unknownMethod", message: "no such method" } });
}
function reply(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
`;

function CreateOptions(overrides: Partial<CoreClientOptions> = {}): CoreClientOptions {
  return {
    // The extension host runs inside Electron, so `process.execPath` is the
    // Electron binary; ELECTRON_RUN_AS_NODE makes it behave as plain Node.
    executable: process.execPath,
    arguments: ["-e", FakeSidecar],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    requestTimeoutMs: 5_000,
    handshakeTimeoutMs: 15_000,
    ...overrides,
  };
}

suite("CoreClient", () => {
  let client: CoreClient | undefined;

  teardown(() => {
    client?.Dispose();
    client = undefined;
  });

  test("resolves a request and matches it by id", async () => {
    client = new CoreClient(CreateOptions());

    const result = await client.CallAsync<{ pong: boolean }>("ping", {});

    assert.deepStrictEqual(result, { pong: true });
    assert.strictEqual(client.IsRunning, true);
  });

  test("surfaces a sidecar error code", async () => {
    client = new CoreClient(CreateOptions());

    await assert.rejects(
      () => client!.CallAsync("deny", {}),
      (error: unknown) =>
        error instanceof CoreError && error.code === "unauthorized" && error.message === "nope"
    );
  });

  test("rejects on timeout and tells the sidecar to cancel", async () => {
    const canceled: Array<string> = [];
    client = new CoreClient(
      CreateOptions({
        requestTimeoutMs: 300,
        onStderr: (line) => canceled.push(line),
      })
    );

    await assert.rejects(
      () => client!.CallAsync("hang", {}),
      (error: unknown) => error instanceof CoreError && error.code === "timeout"
    );

    await WaitForAsync(() => canceled.some((line) => line.startsWith("cancel:")));
  });

  test("rejects with cancelled when the signal aborts", async () => {
    const canceled: Array<string> = [];
    client = new CoreClient(CreateOptions({ onStderr: (line) => canceled.push(line) }));
    await client.CallAsync("ping", {});

    const controller = new AbortController();
    const pending = client.CallAsync("hang", {}, controller.signal);
    controller.abort();

    await assert.rejects(
      () => pending,
      (error: unknown) => error instanceof CoreError && error.code === "cancelled"
    );
    await WaitForAsync(() => canceled.some((line) => line.startsWith("cancel:")));
  });

  test("rejects outstanding calls when the sidecar crashes, then restarts", async () => {
    client = new CoreClient(CreateOptions());

    await assert.rejects(
      () => client!.CallAsync("crash", {}),
      (error: unknown) => error instanceof CoreError && error.code === "crashed"
    );

    const result = await client.CallAsync<{ pong: boolean }>("ping", {});
    assert.deepStrictEqual(result, { pong: true });
  });

  test("rejects with unavailable when the executable is missing", async () => {
    client = new CoreClient(
      CreateOptions({ executable: "definitely-not-a-real-binary-xyz", arguments: [] })
    );

    await assert.rejects(
      () => client!.CallAsync("ping", {}),
      (error: unknown) => error instanceof CoreError && error.code === "unavailable"
    );
  });

  test("stops restarting after repeated crashes", async () => {
    client = new CoreClient(CreateOptions({ maxRestarts: 1 }));

    await assert.rejects(() => client!.CallAsync("crash", {}));
    await assert.rejects(
      () => client!.CallAsync("ping", {}),
      (error: unknown) => error instanceof CoreError && error.code === "unavailable"
    );
  });
});

async function WaitForAsync(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.fail("condition was not met in time");
}
