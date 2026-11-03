# Clear the two SonarCloud findings on PR 54

Status: APPROVED (2026-11-03, from the SonarCloud PR summary)
Started: 2026-11-03

## Findings (SonarCloud API, PR 54)

Both are in `src/NugetPackageManager.Core.Workspace/Cpm/CpmPropertyResolver.cs`:

1. **csharpsquid:S3267** — line 158, "Loops should be simplified using the `Any` LINQ method".
   `TryReadSingleReference` validates the inner property name with a `foreach` over the characters.
2. **csharpsquid:S3218** (CRITICAL) — line 439, "Rename this property to not shadow the outer
   class' member with the same name". The nested `CacheEntry` record has a `Stamp` property while
   the outer class has a static `Stamp(List<string>)` method.

## Fix

1. Replace the loop with the LINQ predicate, keeping the comment about
   `$([System.String]::Copy(...))`:
   ```csharp
   if (inner.Any(character => !char.IsLetterOrDigit(character) && character is not ('_' or '.' or '-'))))
   {
       return false;
   }
   ```
2. Rename the static method `Stamp` → `BuildStamp` (matching `CpmEvaluator.BuildStamp`), and update
   its two call sites. The `CacheEntry.Stamp` property keeps its name and no longer shadows
   anything.

No behaviour change; no new tests required (existing resolver tests cover both paths).

## Verification

`dotnet build NugetPackageManager.slnx -c Release`, `dotnet test NugetPackageManager.slnx -c Release`,
`npm run quality`, then push and poll the SonarCloud API for PR 54 until `total` is 0.
