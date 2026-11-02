#!/usr/bin/env node
// Parity gate: both implementations must emit identical canonical dumps before any number counts.
//
// Run: node parity.mjs
//
// Env:
//   FIXTURE_DIR   directory of small real inputs (default ./fixtures)
//   WORKLOAD      extra large input to include (default ./work/bench.props)
//   CS_EXE        C# harness executable (default ./cs-harness/bin/Release/net8.0/cs-harness.exe)
//   TS_BENCH      path to ts-bench.mjs (default ./ts-bench.mjs)
//   FILTER        optional substring; only matching fixture names are compared
//
// Dumps are produced by `ts-bench.mjs <file> dump` and `<CS_EXE> <file> dump`; both must print
// one JSON object with the same canonical shape.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const fixtureDir = process.env.FIXTURE_DIR ?? "./fixtures";
const workload = process.env.WORKLOAD ?? "./work/bench.props";
const csExe = process.env.CS_EXE ?? "./cs-harness/bin/Release/net8.0/cs-harness.exe";
const tsBench = process.env.TS_BENCH ?? "./ts-bench.mjs";
const filter = process.env.FILTER ?? "";

const files = [];
if (fs.existsSync(fixtureDir)) {
  for (const name of fs.readdirSync(fixtureDir)) {
    if (name.includes(filter)) files.push(path.join(fixtureDir, name));
  }
}
if (fs.existsSync(workload)) files.push(workload);

if (files.length === 0) {
  console.error(`No inputs found (fixtures: ${fixtureDir}, workload: ${workload})`);
  process.exit(2);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const runDump = (cmd, args) =>
  JSON.parse(execFileSync(cmd, args, { maxBuffer: 1 << 28, encoding: "utf8" }));

let failures = 0;
const summary = [];

for (const file of files) {
  const ts = runDump(process.execPath, ["--expose-gc", tsBench, file, "dump"]);
  const cs = runDump(csExe, [file, "dump"]);

  const mapEqual = same(ts.map, cs.map);
  const resolvedEqual = ts.resolved === undefined ? null : same(ts.resolved, cs.resolved);
  const ok = mapEqual && resolvedEqual !== false;
  if (!ok) failures++;

  summary.push({ file: path.basename(file), mapEqual, resolvedEqual });
  console.log(`${ok ? "PARITY" : "DIFF  "} ${path.basename(file)}`);

  if (!mapEqual) {
    const keys = (m) => Object.keys(m?.unconditional ?? {}).length;
    console.log(`   unconditional: ts=${keys(ts.map)} cs=${keys(cs.map)}`);
    console.log(`   groups: ts=${ts.map.conditional?.length} cs=${cs.map.conditional?.length}`);
  }
  if (resolvedEqual === false) {
    const ids = Object.keys(ts.resolved ?? {});
    const first = ids.find((id) => !same(ts.resolved[id], cs.resolved?.[id]));
    console.log(`   first differing resolution: ${first}`);
    console.log(`     ts=${JSON.stringify(ts.resolved[first])}`);
    console.log(`     cs=${JSON.stringify(cs.resolved?.[first])}`);
  }
}

fs.mkdirSync("./out", { recursive: true });
fs.writeFileSync("./out/parity.json", JSON.stringify(summary, null, 2));
console.log(`\n${files.length - failures}/${files.length} inputs identical`);
process.exit(failures === 0 ? 0 : 1);
