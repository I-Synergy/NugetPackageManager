#!/usr/bin/env node
// Inventory a TypeScript VS Code extension before porting logic to a .NET sidecar.
//
// Usage: node inventory.mjs [src-dir] [--json]
//
// Reports, per module: lines, whether it imports `vscode` (cannot move), and whether it imports a
// Node-only module the sidecar cannot rely on. Prints totals per top-level folder and the movable
// line count, so you can size the waves before writing any C#.
import fs from "node:fs";
import path from "node:path";

const target = process.argv[2] ?? "src";
const asJson = process.argv.includes("--json");

const SKIP_DIRS = new Set(["node_modules", "out", "dist", "coverage", ".git", "bin", "obj"]);
const VCS_API = /from\s+["']vscode["']|require\(\s*["']vscode["']\s*\)/;
const NODE_ONLY =
  /from\s+["'](node:|fs|path|os|child_process|worker_threads|net|http|https|crypto|stream|zlib|util)["']/;
// A file that talks to the extension host (postMessage/acquireVsCodeApi) is also host-bound.
const WEBVIEW_API = /acquireVsCodeApi|postMessage\s*\(/;

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
};

if (!fs.existsSync(target)) {
  console.error(`Not found: ${target}`);
  process.exit(2);
}

const files = walk(target)
  .map((file) => {
    const text = fs.readFileSync(file, "utf8");
    return {
      file: path.relative(target, file).replaceAll("\\", "/"),
      lines: text.split(/\r?\n/).length,
      vscodeApi: VCS_API.test(text),
      webviewApi: WEBVIEW_API.test(text),
      nodeOnly: NODE_ONLY.test(text),
    };
  })
  .sort((a, b) => b.lines - a.lines);

const hostBound = (f) => f.vscodeApi || f.webviewApi;
const summary = new Map();
for (const f of files) {
  const group = f.file.includes("/") ? f.file.slice(0, f.file.indexOf("/")) : "(root)";
  const row = summary.get(group) ?? { group, files: 0, lines: 0, movableFiles: 0, movableLines: 0 };
  row.files += 1;
  row.lines += f.lines;
  if (!hostBound(f)) {
    row.movableFiles += 1;
    row.movableLines += f.lines;
  }
  summary.set(group, row);
}

const totals = files.reduce(
  (acc, f) => {
    acc.files += 1;
    acc.lines += f.lines;
    if (!hostBound(f)) {
      acc.movableFiles += 1;
      acc.movableLines += f.lines;
    }
    if (f.vscodeApi) acc.vscodeImports += 1;
    return acc;
  },
  { files: 0, lines: 0, movableFiles: 0, movableLines: 0, vscodeImports: 0 }
);

if (asJson) {
  process.stdout.write(JSON.stringify({ target, files, byGroup: [...summary.values()], totals }, null, 2));
} else {
  console.log(`Inventory of ${target}`);
  console.log("");
  console.log("Modules (largest first):");
  for (const f of files) {
    const tag = f.vscodeApi ? "vscode" : f.webviewApi ? "webview" : f.nodeOnly ? "node" : "movable";
    console.log(`  ${String(f.lines).padStart(5)}  ${tag.padEnd(8)} ${f.file}`);
  }

  console.log("\nBy group:");
  console.log("  group                    files  lines  movable files  movable lines");
  for (const row of [...summary.values()].sort((a, b) => b.movableLines - a.movableLines)) {
    console.log(
      `  ${row.group.padEnd(22)} ${String(row.files).padStart(6)} ${String(row.lines).padStart(6)} ` +
        `${String(row.movableFiles).padStart(14)} ${String(row.movableLines).padStart(14)}`
    );
  }

  const pct = totals.lines === 0 ? 0 : Math.round((totals.movableLines / totals.lines) * 100);
  console.log(
    `\nTotal: ${totals.files} modules, ${totals.lines} lines; ` +
      `${totals.movableFiles} movable modules (${pct}% of lines); ` +
      `${totals.vscodeImports} import vscode.`
  );
  console.log("Next: group movable modules into coherent domain waves (see references/porting-waves.md).");
}
