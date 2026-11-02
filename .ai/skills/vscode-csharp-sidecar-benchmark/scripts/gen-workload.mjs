#!/usr/bin/env node
// Synthetic workload generator: a large but realistic-shaped XML file for parse benchmarks.
//
// Env:
//   OUT          output file (default ./work/bench.props)
//   ENTRIES      unconditional entries (default 1000)
//   GROUPS       conditional groups (default 12)
//   PER_GROUP    entries per conditional group (default 100)
//   ITEM         element name (default PackageVersion)
//   ID_PREFIX    id prefix (default Pkg.N)
//   FRAMEWORKS   comma-separated framework names used for the conditions
//
// Shape rules that matter: reuse the real file's condition syntax, reuse ids across groups
// (that is what exercises last-wins and per-TFM resolution), and keep groups in document order.
import fs from "node:fs";
import path from "node:path";

const out = process.env.OUT ?? "./work/bench.props";
const entries = Number(process.env.ENTRIES ?? 1000);
const groups = Number(process.env.GROUPS ?? 12);
const perGroup = Number(process.env.PER_GROUP ?? 100);
const item = process.env.ITEM ?? "PackageVersion";
const idPrefix = process.env.ID_PREFIX ?? "Pkg.N";
const frameworks = (
  process.env.FRAMEWORKS ??
  [
    "net8.0",
    "net9.0",
    "net10.0",
    "net11.0",
    "net10.0-windows",
    "net8.0-windows",
    "net9.0-windows",
    "net11.0-windows",
    "net10.0-android",
    "net10.0-ios",
    "net10.0-macos",
    "net9.0-maccatalyst",
  ].join(",")
).split(",");

const id = (i) => `${idPrefix}${String(i).padStart(4, "0")}`;
const lines = [
  "<Project>",
  "  <PropertyGroup>",
  "    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>",
  "  </PropertyGroup>",
  "  <ItemGroup>",
];
for (let i = 0; i < entries; i++) {
  lines.push(`    <${item} Include="${id(i)}" Version="1.${i % 20}.${i % 7}" />`);
}
lines.push("  </ItemGroup>");

frameworks.slice(0, groups).forEach((tfm, group) => {
  lines.push(`  <ItemGroup Condition="'$(TargetFramework)' == '${tfm}'">`);
  for (let k = 0; k < perGroup; k++) {
    const i = (group * Math.max(1, Math.floor(entries / groups) - 20) + k) % entries;
    lines.push(`    <${item} Include="${id(i)}" Version="2.${group}.${k % 5}" />`);
  }
  lines.push("  </ItemGroup>");
});
lines.push("</Project>", "");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, lines.join("\n"), "utf8");
console.log(`${out}: ${lines.length} lines, ${(fs.statSync(out).size / 1024).toFixed(1)} KiB`);
