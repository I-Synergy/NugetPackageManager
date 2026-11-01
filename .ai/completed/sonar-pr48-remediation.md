# SonarCloud PR 48 remediation

Status: DONE
Started: 2026-11-02
Finished: 2026-11-02
Plan: `.ai/plans/sonar-pr48-remediation.md`

## Steps

- [x] Fix S3218 shadowing in `CpmEvaluator` and `CpmPropertyLocator`
- [x] Reduce `CpmPropertyLocator.ParsePreprocessed` and `ApplyBoundary` complexity
- [x] Replace `UpdatePackageVersionAsync`'s optional parameters with `CpmWriteOptions`
- [x] Reduce `CpmWriter.ResolvePropertyEditAsync` and `AddressedOccurrences` complexity
- [x] Make `WritePlan.propertyFiles` readonly; const the `propsFilePath` literal
- [x] Build + full C# test suite
- [x] Push and confirm the new Sonar analysis has no open PR issues

## Notes

- 9 open issues, 70 minutes of estimated debt.
- First push cleared 2 issues and exposed 7 second-order findings (three null-forgiving
  operators, one redundant switch pattern, three walker-only helpers). The second push cleared
  all of them; SonarCloud PR 48 analysis reports `total: 0`.
