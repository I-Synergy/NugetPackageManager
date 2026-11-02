# Fix stale CPM version cache in the .NET core

Status: DONE
Started: 2026-11-02
Completed: 2026-11-02
Scope: core cache invalidation only (no UI or watcher changes)
Owner: Reasonix Code

## Problem

`WorkspaceModelService.LoadCpmMap` caches the parsed `Directory.Packages.props`
per file in `cpmCache`, and nothing ever removes an entry:

```csharp
if (cpmCache.TryGetValue(cpmFile, out var cached))
{
    return cached;
}
var parsed = CpmPropsReader.Parse(File.ReadAllText(cpmFile));
cpmCache[cpmFile] = parsed;
```

`InvalidateVersionCache()` clears only the MSBuild evaluator cache, not this map.
The sidecar therefore keeps serving the versions it parsed at start-up for the
whole lifetime of the process.

Observed consequence: the Installed tab showed
`Npgsql.EntityFrameworkCore.PostgreSQL 10.0.0`,
`Microsoft.Playwright.MSTest 1.64.0` and `MSTest.TestAdapter 4.5.1` while
`Directory.Packages.props` contained `11.0.0-rc.3`, `1.64.1` and `4.5.2`. Those
are exactly the pre-update values, including after successful batch updates made
by the extension itself.

## Steps

- [ ] Stamp each `cpmCache` entry with the props file's last-write time (UTC)
      and length; re-parse when either differs.
- [ ] Clear `cpmCache` in `InvalidateVersionCache()` so writes made through the
      extension are re-read even when the filesystem timestamp is coarse.
- [ ] Add an MSTest regression: parse, rewrite the props file outside the
      service, parse again, assert the new version.
- [ ] Run the Core.Workspace tests and the solution build.

## Out of scope (follow-ups)

- Watching `Directory.Packages.props` / `Directory.Build.props` and pushing an
  auto-refresh to the webview. A manual refresh now returns fresh data.
- Showing the resolved version from `project.assets.json` in the Installed tab.
