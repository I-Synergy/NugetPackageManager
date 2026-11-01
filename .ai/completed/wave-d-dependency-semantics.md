# Wave D — dependency semantics through the .NET core

Status: DONE
Started: 2026-11-01
Completed: 2026-11-01

## Steps

- [x] Port `dependency-graph.ts` to `Core.Workspace/Dependencies/AssetsGraph.cs` using
      `System.Text.Json`; analysis, direct references, redundant/pinned verdicts, chain BFS
- [x] Port `requirement-closure.ts` to `Core.Workspace/Dependencies/RequirementClosure.cs`;
      fixpoint walk, per-TFM conflicts, apply order
- [x] Add `NuGet.Versioning` / `NuGet.Frameworks` to `Core.Workspace` and put ordering, range
      bounds and range matching in `VersionSemantics`
- [x] Add `DependencyHandlers` (`analyzeProjectDependencies`,
      `getRestoredDirectDependencies`, `computeRequirementClosure`, `orderRequirements`) and
      register them in `Program.cs`
- [x] Switch the host: assets reads, closure and ordering now go over RPC; the closure handler
      fetches dependency metadata from the configured sources and selects the TFM group with
      `NuGetFramework`; proxy passed in from the host
- [x] Delete `dependency-graph.ts`, `requirement-closure.ts` and their TS tests
- [x] Add C# tests: `AssetsGraphTests` (10), `RequirementClosureTests` (9),
      `VersionSemanticsTests` (4), `DependencyHandlersTests` (5)
- [x] Verify: `dotnet test` 134/134, `npm test` 427 passing, `npm run typecheck`,
      `npm run lint`, `npm run esbuild`, `git diff --check`

## Notes

- `version.ts` stays in TypeScript on purpose. Its remaining consumers are host-side loops and
  sort comparators (`getOutdatedPackages`, vulnerability matching, installed-range constraints),
  `local-feed.ts` (Wave B remainder) and the toolchain modules (Wave F). Porting the primitive
  would mean moving those whole operations, against principle 1 of the migration plan. It moves
  when its last consumer does.
- Behaviour changes worth knowing: `VersionSemantics.RangeLowerBound` returns null for floating
  ranges (`1.*`) instead of the literal text (no single required version); range matching for
  floating ranges uses `FloatRange`; unparseable ranges remain unconstrained.
- The preflight still runs the installed-range check in TypeScript (it uses the scan graph and
  the host's metadata cache); only the closure and ordering moved.
