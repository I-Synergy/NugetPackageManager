# CPM read path through the .NET core (C2 closed)

Status: DONE
Started: 2026-11-01
Completed: 2026-11-01

## Steps

- [x] Add `utilities/cpm-reader.ts` as the host adapter over the core's `getCpmMap`
- [x] Inline `getTfmMajorVersion` in `host-api.ts`
- [x] Switch the `CpmResolver` read call sites (batch, consolidation, project update, cleanup,
      conflict preflight/repair, `updateCentralVersions`)
- [x] Delete `cpm-resolver.ts`, `cpm-condition.ts` and their tests
      (`cpm-resolver.test.ts`, `cpm-condition.test.ts`, `cpm-fixtures.test.ts`)
- [x] Convert the orchestration tests in `host-api.test.ts` to core-call assertions and drop the
      TypeScript-writer bridge
- [x] Add `cpm-reader.test.ts` for the adapter seams (directory walk, opt-out, wire → `Map`)
- [x] Verify: `npm run typecheck`, `npm run lint`, `npm run esbuild`, `npm test` → 427 passing

## Notes

- `GetPackageVersionsAsync` (the flat map) had only membership consumers. It is replaced by
  `CpmReader.HasPackage` / `CpmReader.PackageIds`, so no approximate flat map is rebuilt in
  TypeScript; the real flat read stays in `CpmPropsReader.ReadFlatVersions`.
- Core parse errors now propagate to the caller instead of being swallowed into an empty map.
- Rollback/cancel tests install a test-local `stubCoreCall` that simulates the core's write, so the
  file-restoration assertion still has meaning; production code never routes writes to TypeScript.
- Waves D, E and F remain on `.ai/plans/ts-to-csharp-migration.md`.
