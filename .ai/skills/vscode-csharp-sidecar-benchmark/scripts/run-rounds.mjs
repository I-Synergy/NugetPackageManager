#!/usr/bin/env node
// Interleaved paired rounds: TS process and C# process alternate, so drift hits both.
//
// Run: node run-rounds.mjs
//
// Env:
//   FILES   JSON array of {"label","file"} (required)
//   ROUNDS  paired rounds (default 3)
//   CS_EXE  C# harness executable (default ./cs-harness/bin/Release/net8.0/cs-harness.exe)
//   TS_BENCH path to ts-bench.mjs (default ./ts-bench.mjs)
//   NODE_ARGS extra Node args, space separated (default --expose-gc)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const files = JSON.parse(process.env.FILES ?? "[]");
if (!Array.isArray(files) || files.length === 0) {
  console.error('FILES must be a JSON array, e.g. \'[{"label":"large","file":"./work/bench.props"}]\'');
  process.exit(2);
}

const rounds = Number(process.env.ROUNDS ?? 3);
const csExe = process.env.CS_EXE ?? "./cs-harness/bin/Release/net8.0/cs-harness.exe";
const tsBench = process.env.TS_BENCH ?? "./ts-bench.mjs";
const nodeArgs = (process.env.NODE_ARGS ?? "--expose-gc").split(" ").filter(Boolean);

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const run = (cmd, args) => JSON.parse(execFileSync(cmd, args, { maxBuffer: 1 << 28, encoding: "utf8" }));
const kib = (bytes) => Math.round(bytes / 1024);
const mib = (bytes) => +(bytes / 1048576).toFixed(1);

const rows = [];
for (const { label, file } of files) {
  const ts = [];
  const cs = [];
  for (let round = 0; round < rounds; round++) {
    ts.push(run(process.execPath, [...nodeArgs, tsBench, file, "bench"]));
    cs.push(run(csExe, [file, "bench"]));
  }

  for (const [variant, samples] of [["ts", ts], ["cs", cs]]) {
    const parse = samples.map((s) => s.parse);
    const resolve = samples.map((s) => s.resolve).filter(Boolean);
    rows.push({
      label,
      variant,
      parseMedianMs: +median(parse.flatMap((p) => p.timesMs)).toFixed(3),
      parsePerRoundMedianMs: samples.map((s) => +median(s.parse.timesMs).toFixed(3)),
      resolveMedianMs: resolve.length ? +median(resolve.flatMap((r) => r.timesMs)).toFixed(3) : null,
      parseHeapGrowthKiB: kib(median(parse.map((p) => p.heapGrowthPerOpBytes))),
      parseAllocatedKiB: parse[0].allocatedBytesPerOp
        ? kib(median(parse.map((p) => p.allocatedBytesPerOp)))
        : null,
      resolveAllocatedKiB:
        resolve[0]?.allocatedBytesPerOp !== undefined
          ? kib(median(resolve.map((r) => r.allocatedBytesPerOp)))
          : null,
      parsePeakRssMiB: mib(median(parse.map((p) => p.peakRssBytes))),
      parseRetainedKiB: kib(median(parse.map((p) => Math.max(0, p.retainedBytes)))),
    });
  }
}

console.log("file | variant | parse ms | resolve ms | heap growth/op KiB | alloc/op KiB | resolve alloc/op KiB | peak RSS MiB | retained KiB");
for (const r of rows) {
  console.log(
    `${r.label} | ${r.variant} | ${r.parseMedianMs} | ${r.resolveMedianMs ?? "-"} | ${r.parseHeapGrowthKiB} | ${r.parseAllocatedKiB ?? "-"} | ${r.resolveAllocatedKiB ?? "-"} | ${r.parsePeakRssMiB} | ${r.parseRetainedKiB}`
  );
}
console.log("\nper-round parse medians:");
for (const r of rows) console.log(`  ${r.label} / ${r.variant}: ${JSON.stringify(r.parsePerRoundMedianMs)}`);

fs.mkdirSync("./out", { recursive: true });
fs.writeFileSync("./out/rounds.json", JSON.stringify(rows, null, 2));
