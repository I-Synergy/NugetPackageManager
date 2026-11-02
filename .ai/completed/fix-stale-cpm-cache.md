# Fix stale CPM version cache in the .NET core

Status: DONE
Started: 2026-11-02
Completed: 2026-11-02

## Steps
- [x] Stamp the `cpmCache` entry with the props file's last-write time and length
- [x] Clear `cpmCache` in `InvalidateVersionCache()`
- [x] Add the MSTest regression for an external props edit
- [x] Run the Core.Workspace tests and the solution build

## Notes
- `dotnet test NugetPackageManager.slnx -c Release --no-build`: Core 89, Core.NuGet 57,
  Core.Workspace 147 — all passing (the new regression is the 147th).
- `dotnet build NugetPackageManager.slnx -c Release`: succeeded, 0 warnings, 0 errors.
- The Installed tab still needs a refresh (or a tab reopen) after an external
  `Directory.Packages.props` edit; watching props files and pushing a refresh is a
  separate follow-up.
