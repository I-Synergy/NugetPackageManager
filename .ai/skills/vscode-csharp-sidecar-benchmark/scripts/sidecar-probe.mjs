#!/usr/bin/env node
// Real sidecar probe: idle/loaded RSS, steady-state round-trip latency, and payload capture.
//
// Run: node sidecar-probe.mjs
//
// Env:
//   CORE_DLL     path to the sidecar dll (required), e.g. src/.../bin/Release/net8.0/App.dll
//   PROPS        input file passed to the method (default ./work/bench.props)
//   METHOD       RPC method name (default getCpmMap)
//   PARAM        parameter name for the input path (default propsFilePath)
//   CALLS        measured calls (default 50; use 200 for the plateau/leak test)
//   SAVE_WIRE    where to write the first response value (default ./out/wire/core.json)
//   EXPECT_READY "false" if the transport has no {"ready":true} line
//   SPAWN_ARGS   extra args before the dll (rarely needed)
//
// Transport assumption: NDJSON, one JSON object per line, requests {id, method, params},
// responses {id, ok, value | error}. See references/sidecar-transport-and-rss.md for the
// Content-Length variant.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const dll = process.env.CORE_DLL;
if (!dll) throw new Error("CORE_DLL is required");
const input = process.env.PROPS ?? "./work/bench.props";
const method = process.env.METHOD ?? "getCpmMap";
const paramName = process.env.PARAM ?? "propsFilePath";
const calls = Number(process.env.CALLS ?? 50);
const saveWire = process.env.SAVE_WIRE ?? "./out/wire/core.json";
const expectReady = (process.env.EXPECT_READY ?? "true") !== "false";
const spawnArgs = (process.env.SPAWN_ARGS ?? "").split(" ").filter(Boolean);

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Windows: PowerShell is the portable way to read another process's working set. */
const rssOf = (pid) =>
  Number(
    execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`], {
      encoding: "utf8",
    }).trim()
  );

const child = spawn(process.env.DOTNET ?? "dotnet", [...spawnArgs, dll], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));

const rl = readline.createInterface({ input: child.stdout });
let nextId = 0;
const pending = new Map();
let markReady;
const readyPromise = new Promise((resolve) => (markReady = resolve));

rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return; // stderr noise or a protocol banner
  }
  if (message.ready === true) {
    markReady();
    return;
  }
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  if (message.ok === true) call.resolve(message.value);
  else call.reject(new Error(JSON.stringify(message.error)));
});

const call = (name, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method: name, params })}\n`);
  });

const startedAt = process.hrtime.bigint();
if (expectReady) {
  await Promise.race([
    readyPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("sidecar never reported ready")), 15000)),
  ]);
}
const readyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

await new Promise((resolve) => setTimeout(resolve, 1500));
const idleRss = [rssOf(child.pid), rssOf(child.pid), rssOf(child.pid)];

const latenciesMs = [];
const rssSamples = [];
let first;

for (let i = 0; i < calls; i++) {
  const t0 = process.hrtime.bigint();
  const value = await call(method, { [paramName]: input });
  const t1 = process.hrtime.bigint();
  latenciesMs.push(Number(t1 - t0) / 1e6);
  if (i === 0) first = value;
  if ((i + 1) % 10 === 0) rssSamples.push({ after: i + 1, rssBytes: rssOf(child.pid) });
}

fs.mkdirSync(path.dirname(saveWire), { recursive: true });
fs.writeFileSync(saveWire, JSON.stringify(first));

child.stdin.end();
child.kill();

const result = {
  dll,
  input,
  method,
  calls,
  readyMs,
  idleRssBytes: idleRss.at(-1),
  rssAfterCalls: rssSamples,
  peakRssBytes: Math.max(...rssSamples.map((s) => s.rssBytes)),
  settledRssBytes: rssSamples.at(-1)?.rssBytes,
  latencyMedianMs: median(latenciesMs),
  latencySteadyMedianMs: median(latenciesMs.slice(-20)),
  latenciesMs,
  savedWire: saveWire,
};

if (stderr.trim()) result.stderrTail = stderr.trim().split("\n").slice(-5).join("\n");
process.stdout.write(JSON.stringify(result));
