# SonarCloud PR 48 remediation

Status: IN PROGRESS
Started: 2026-11-02
Plan: `.ai/plans/sonar-pr48-remediation.md`

## Steps

- [ ] Fix S3218 shadowing in `CpmEvaluator` and `CpmPropertyLocator`
- [ ] Reduce `CpmPropertyLocator.ParsePreprocessed` and `ApplyBoundary` complexity
- [ ] Replace `UpdatePackageVersionAsync`'s optional parameters with `CpmWriteOptions`
- [ ] Reduce `CpmWriter.ResolvePropertyEditAsync` and `AddressedOccurrences` complexity
- [ ] Make `WritePlan.propertyFiles` readonly; const the `propsFilePath` literal
- [ ] Build + full C# test suite
- [ ] Push and confirm the new Sonar analysis has no open PR issues

## Notes

- 9 open issues, 70 minutes of estimated debt.
