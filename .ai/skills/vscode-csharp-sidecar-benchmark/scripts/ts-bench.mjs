#!/usr/bin/env node
// Node harness for the TypeScript baseline: time, heap growth, retention, peak RSS.
//
// Run:  node --expose-gc ts-bench.mjs <input-file> [bench|dump|idle]
//
// Env:
//   MODULE      path to a CJS bundle exporting the parser as `module.exports.default`
//               (default ./out/baseline.cjs; build it with esbuild --format=cjs --node-paths=<repo>/node_modules)
//   PARSE_AS    static method name that parses content  (default parsePackageMapFromContent)
//   RESOLVE_AS  static method name that derives results (default ResolveVersions; empty to skip)
//   TFMS        comma-separated frameworks for resolve (default net10.0,net10.0-windows)
//   WARMUP      warmup iterations (default 5)
//   RUNS        measured iterations (default 30)
//
// ADAPT:
//   - `toWire` below assumes a map shape {unconditional: Map, conditional: [{condition,
//     framework, versions: Map, order}], hasConditionalGroups}. Rename to match your parser.
//   - Dump mode exists for the parity gate; keep key ordering deterministic (sort).
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const modulePath = process.env.MODULE ?? "./out/baseline.cjs";
const Parser = require(modulePath).default ?? require(modulePath);

const parseAs = process.env.PARSE_AS ?? "parsePackageMapFromContent";
const resolveAs = process.env.RESOLVE_AS ?? "ResolveVersions";
const TFMS = (process.env.TFMS ?? "net10.0,net10.0-windows").split(",").map((t) => t.trim());
const WARMUP = Number(process.env.WARMUP ?? 5);
const RUNS = Number(process.env.RUNS ?? 30);

const file = process.argv[2];
const mode = process.argv[3] ?? "bench";
const content = fs.readFileSync(file, "utf8");

const parse = (input) => Parser[parseAs](input);
const resolve = (map, ids, tfms) => (resolveAs ? Parser[resolveAs](map, ids, tfms) : undefined);

const gcNow = () => {
  if (typeof global.gc !== "function") throw new Error("run with --expose-gc");
  global.gc();
  global.gc();
};

if (mode === "idle") {
  process.stdout.write(JSON.stringify({ variant: "ts", idleRssBytes: process.memoryUsage().rss }));
  process.exit(0);
}

/** The ids the file actually defines — never a fixed list, or you benchmark the fallback path. */
const idsOf = (map) => {
  const ids = [...(map.unconditional?.keys() ?? [])];
  const seen = new Set(ids.map((id) => id.toLowerCase()));
  for (const entry of map.conditional ?? []) {
    for (const id of entry.versions?.keys() ?? []) {
      if (!seen.has(id.toLowerCase())) {
        seen.add(id.toLowerCase());
        ids.push(id);
      }
    }
  }
  return ids;
};

// ADAPT: canonical wire shape for the parity gate.
const toWire = (map) => ({
  unconditional: Object.fromEntries(
    [...map.unconditional.entries()].sort(([a], [b]) => a.localeCompare(b))
  ),
  conditional: map.conditional
    .map((entry) => ({
      condition: entry.condition,
      framework: entry.framework,
      versions: Object.fromEntries(
        [...entry.versions.entries()].sort(([a], [b]) => a.localeCompare(b))
      ),
      order: entry.order,
    }))
    .sort((a, b) => a.framework.localeCompare(b.framework) || a.condition.localeCompare(b.condition)),
  hasConditionalGroups: map.hasConditionalGroups,
});

if (mode === "dump") {
  const map = parse(content);
  const result = { map: toWire(map) };

  if (resolveAs) {
    const ids = idsOf(map);
    const resolved = resolve(map, ids, TFMS);
    const wire = {};
    for (const [id, rows] of [...resolved.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // ADAPT the row fields to your resolution type.
      wire[id] = rows
        .map((r) => ({ tfm: r.Tfm, version: r.Version, condition: r.Condition, matched: r.Matched }))
        .sort((a, b) => a.tfm.localeCompare(b.tfm) || a.condition.localeCompare(b.condition));
    }
    result.resolved = wire;
  }

  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

/** One measurement phase: warmup, GC, then N timed iterations holding the last result. */
function phase(label, operation) {
  let last;
  for (let i = 0; i < WARMUP; i++) last = operation();
  globalThis.__keep = last;
  gcNow();

  const baseHeap = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const timesMs = [];

  for (let i = 0; i < RUNS; i++) {
    const t0 = process.hrtime.bigint();
    last = operation();
    const t1 = process.hrtime.bigint();
    timesMs.push(Number(t1 - t0) / 1e6);

    const now = process.memoryUsage();
    if (now.rss > peakRss) peakRss = now.rss;
  }

  const beforeGc = process.memoryUsage().heapUsed;
  globalThis.__keep = last;
  gcNow();
  const afterGc = process.memoryUsage().heapUsed;

  return {
    label,
    timesMs,
    heapGrowthPerOpBytes: Math.round((beforeGc - baseHeap) / RUNS),
    peakRssBytes: peakRss,
    retainedBytes: afterGc - baseHeap,
  };
}

const parsed = parse(content);
const parsePhase = phase("parse", () => parse(content));
const resolvePhase = resolveAs
  ? phase("resolve", () => resolve(parsed, idsOf(parsed), TFMS))
  : null;
globalThis.__keep = parsed;

process.stdout.write(
  JSON.stringify({ variant: "ts", file, runs: RUNS, parse: parsePhase, resolve: resolvePhase })
);
