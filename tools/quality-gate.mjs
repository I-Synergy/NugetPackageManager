#!/usr/bin/env node

// Local mirror of the GitHub Actions quality gate (.github/workflows/quality-gate.yml).
// Run this before committing so a red pipeline is fixed locally, not after the push.
//
// Usage: node tools/quality-gate.mjs [--coverage] [--fix] [--skip-build] [--skip-tests] [--help]
//
// Steps: build -> lint (ESLint + SonarJS) -> type check -> C# build -> C# tests
//        -> compile tests -> tests -> npm audit.
// With --coverage the test step writes coverage/lcov.info for the SonarCloud scan in CI.
//
// The C# steps are skipped with a warning when no .NET SDK (9.0.200+ for the .slnx solution)
// is available, so the gate still works on a machine without it.

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const SOLUTION = "NugetPackageManager.slnx";
/** `.slnx` solutions need this SDK; older ones cannot read the file at all. */
const MINIMUM_DOTNET = [9, 0, 200];

const args = new Set(process.argv.slice(2));
const help = args.has("--help") || args.has("-h");
const coverage = args.has("--coverage");
const fix = args.has("--fix");
const skipBuild = args.has("--skip-build");
const skipTests = args.has("--skip-tests");

if (help) {
  console.log(`Usage: node tools/quality-gate.mjs [options]

  --coverage    collect coverage/lcov.info while running the test suite
  --fix         let ESLint apply its automatic fixes before the gate runs
  --skip-build  skip the esbuild bundle step
  --skip-tests  skip test compilation and execution (TypeScript and C#)
  --help        show this message`);
  process.exit(0);
}

function run(label, command, commandArgs, { shell = isWindows } = {}) {
  console.log(`\n=== ${label} ===`);
  const started = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    // npm/npx are .cmd shims on Windows and must be launched through the shell. `dotnet` is a
    // real executable, and cmd.exe would split arguments that contain a space
    // (`--collect:XPlat Code Coverage`), so the C# steps opt out.
    shell,
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (result.error) {
    console.error(`\n✗ ${label} failed to start: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${result.status ?? "unknown"}) after ${seconds}s`);
    return false;
  }
  console.log(`✓ ${label} (${seconds}s)`);
  return true;
}

if (fix) {
  console.log("Applying ESLint automatic fixes…");
  run("Lint fix", "npm", ["run", "lint:fix"]);
}

const steps = [];

/**
 * Absolute path of the `dotnet` host. Resolving it keeps the gate from executing whatever a
 * user-writable directory on PATH happens to provide; PATH stays the last resort only.
 */
function resolveDotnetHost() {
  const candidates = [
    process.env.DOTNET_HOST_PATH,
    isWindows ? join(process.env.ProgramFiles ?? String.raw`C:\Program Files`, "dotnet", "dotnet.exe") : null,
    isWindows ? null : "/usr/share/dotnet/dotnet",
    isWindows ? null : "/usr/local/share/dotnet/dotnet",
    isWindows ? null : join(homedir(), ".dotnet", "dotnet"),
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) ?? "dotnet";
}

/** The installed .NET SDK version, or null when there is no usable one. */
function resolveDotnetSdk() {
  const probe = spawnSync(resolveDotnetHost(), ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (probe.error || probe.status !== 0) {
    return null;
  }

  const version = (probe.stdout ?? "").trim();
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  const [major = 0, minor = 0, patch = 0] = parts;
  const [requiredMajor, requiredMinor, requiredPatch] = MINIMUM_DOTNET;

  const tooOld =
    major < requiredMajor ||
    (major === requiredMajor && minor < requiredMinor) ||
    (major === requiredMajor && minor === requiredMinor && patch < requiredPatch);

  if (tooOld) {
    console.warn(
      `  .NET SDK ${version} is too old for ${SOLUTION}; ${MINIMUM_DOTNET.join(".")} or newer is required.`,
    );
    return null;
  }

  return version;
}

if (!skipBuild) {
  steps.push(["Build", "npm", ["run", "esbuild"]]);
}

steps.push(
  ["Lint + SonarJS", "npm", ["run", "lint"]],
  ["Type check", "npm", ["run", "typecheck"]],
);

const dotnetVersion = resolveDotnetSdk();
if (dotnetVersion === null) {
  console.log("\n⚠ No usable .NET SDK — skipping the C# build and tests.");
} else {
  console.log(`\n.NET SDK ${dotnetVersion}`);
  steps.push(["C# build", "dotnet", ["build", SOLUTION, "-c", "Release"], { shell: false }]);

  if (!skipTests) {
    // Coverage always: the report is what the SonarCloud scanner reads (coverage/csharp).
    steps.push([
      "C# tests",
      "dotnet",
      [
        "test",
        SOLUTION,
        "-c",
        "Release",
        "--no-build",
        "--settings",
        "tests/coverlet.runsettings",
        "--collect:XPlat Code Coverage",
        "--results-directory",
        "coverage/csharp",
      ],
      { shell: false },
    ]);
  }
}

if (!skipTests) {
  steps.push(
    ["Compile tests", "npm", ["run", "test-compile"]],
    [
      coverage ? "Tests with coverage" : "Tests",
      "npm",
      ["run", coverage ? "test:coverage" : "test"],
    ],
  );
}

steps.push(["Dependency audit", "npm", ["audit", "--audit-level=high"]]);

if (coverage) {
  // A stale report would let SonarCloud score a previous run.
  rmSync(join(ROOT, "coverage"), { recursive: true, force: true });
}

/** Labels of the steps that failed, in run order. @type {string[]} */
const failed = [];
for (const [label, command, commandArgs, options] of steps) {
  if (!run(label, command, commandArgs, options)) {
    failed.push(label);
  }
}

console.log("\n================ QUALITY GATE ================");
if (failed.length === 0) {
  console.log(`PASS — ${steps.length} step(s) succeeded.`);
  if (!coverage) {
    console.log("Tip: run with --coverage to produce coverage/lcov.info for SonarCloud.");
  }
  process.exit(0);
}

console.log(`FAIL — ${failed.length}/${steps.length} step(s) failed:`);
for (const label of failed) {
  console.log(`  - ${label}`);
}
process.exit(1);
