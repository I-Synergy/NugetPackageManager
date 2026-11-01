# Plan: SonarCloud PR 48 remediation

Status: IMPLEMENTED (2026-11-02) — see `.ai/completed/sonar-pr48-remediation.md`.

## Findings (9)

| Rule | File | Issue | Fix |
|---|---|---|---|
| S3218 | `CpmEvaluator.cs:26` | `CacheEntry.Stamp` shadows the outer `Stamp` method | rename the record property to `FileStamp` |
| S3218 | `CpmPropertyLocator.cs:34` | same | same |
| S3776 | `CpmPropertyLocator.cs:160` | `ParsePreprocessed` complexity 19 > 15 | move the recursive walk into a small nested walker type |
| S3776 | `CpmPropertyLocator.cs:229` | `ApplyBoundary` complexity 16 > 15 | extract markup-line classification |
| S107 | `CpmWriter.cs:249` | `UpdatePackageVersionAsync` has 8 parameters | group the two optional property-write arguments into a `CpmWriteOptions` record |
| S3776 | `CpmWriter.cs:333` | `ResolvePropertyEditAsync` complexity 17 > 15 | extract eligibility, occurrence/reference collection |
| S3776 | `CpmWriter.cs:496` | `AddressedOccurrences` complexity 18 > 15 | switch on scope with one helper per scope |
| S2933 | `CpmWriter.cs:1170` | `propertyFiles` not readonly | add `readonly` |
| S1192 | `WorkspaceHandlers.cs:40` | `"propsFilePath"` repeated 4x | private const |

## Constraints

- Behaviour-preserving; no test changes unless a signature change requires one.
- `dotnet build` (warnings are errors) and the full C# test suite must pass.
- Commit and push to `feat/cpm-property-versions` (PR #48) after the parent verifies.
