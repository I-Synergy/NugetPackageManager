# Add missing central package definitions

Status: APPROVED (2026-11-11)
Started: 2026-11-11
Progress: `.ai/progress/add-missing-cpm-definitions.md`

## Problem

Cleanup → **Used but not defined** only lists package ids (`report.Missing.join(", ")`) and offers no
remedy. Two problems behind that:

1. The report counts every project, including projects that do not use Central Package Management —
   they do not need a central definition, so those rows are false positives.
2. There is no way to add the missing `<PackageVersion>` entries, even when the version is already
   known.

Decision (user): do not flag non-CPM usage; only add when a concrete version is known (from
`project.assets.json` or the reference itself) and show why when it is not.

## Report model

`CleanupReport.Missing` becomes structured:

```ts
type MissingDefinitionReason =
  | "noVersion" | "multipleVersions" | "noPropsFile"
  | "conditionalReference" | "propertyVersion" | "pinnedVersion";

type MissingDefinition = {
  Id: string;
  Version: string;        // "" when unknown
  Projects: string[];     // CPM-enabled projects using it
  PropsFiles: string[];   // governing Directory.Packages.props, deduped
  Actionable: boolean;
  Reason?: MissingDefinitionReason;
};
```

`Used` and `Unused` stay as they are (`Unused` must still consider **every** project's use).

Computation (`buildCleanupReportAsync`):

- Keep a global used map for `Unused`; separately keep the CPM-enabled projects per package.
- `Missing` = ids used by at least one `CpmEnabled` project and not defined in any props file.
- Version: the package's `Version` when non-empty, else the resolved version from that project's
  `obj/project.assets.json` (`loadProjectDependencyGraphAsync`, cached per project). Distinct versions
  → `multipleVersions`; none → `noVersion`.
- Props files: `CpmReader.FindCpmFilePathAsync` for each CPM project; a null → `noPropsFile`.
- Reference safety: read each CPM project's file once and inspect the `PackageReference` with a pure
  helper. `Condition` → `conditionalReference`; a `Version`/`VersionOverride` containing `$(` →
  `propertyVersion`; `IsPinned` → `pinnedVersion`. Otherwise actionable.

## Writers (host-side, pure + tested)

New `src/NugetPackageManager.VSCode.Host/utilities/cpm-definitions.ts`:

- `AddUnconditionalPackageVersions(content, entries)` — insert `<PackageVersion Include Version />`
  into the first `ItemGroup` without a `Condition`; create the group after `<Project …>` when none
  exists; skip ids already present (unconditional or conditional); preserve line endings and the
  surrounding indentation; XML-escape. Returns `{ Content, Changed, CreatedGroup }`.
- `InspectPackageReference(content, packageId)` — `{ Found, HasCondition, Version, VersionOverride }`.
- `RemoveInlinePackageVersion(content, packageId)` — remove a literal `Version` attribute from the
  matching reference; refuse when the element has a `Condition` or the value contains `$(` (report a
  reason instead of editing). `VersionOverride` is left alone.

## Add operation (job)

Types (`rpc/types.ts`): `AddMissingDefinitionsRequest { PackageIds?: string[] }` (omitted = all
actionable), `AddMissingDefinitionsResponse { Added: Array<{ Id, Version, PropsFile }>,
ChangedFiles: string[], Backups: string[], Skipped: Array<{ Id, Reason }> }`, and the new job kind
`addMissingDefinitions` in `GetJobResponse.Kind` / `OperationJobs`.

Host `startAddMissingDefinitionsAsync`:

1. Recompute the report (never trust ids/versions from the webview); keep requested actionable ids.
2. Group by props file; snapshot every props file and every csproj that needs an inline version
   removed; write timestamped `.backup.<stamp>` copies.
3. Write each props file once with `AddUnconditionalPackageVersions`, then re-read and verify every
   id is present.
4. Strip literal inline versions in the CPM projects that have one.
5. Restore the affected projects (`restoreProjectsInternalAsync`).
6. On any failure: roll back every snapshot (`rollbackFilesAsync`) and report the error. On success:
   `invalidateAfterMutation()`.
7. Report progress through the job registry (`Adding definitions 1/3…`).

Webview (`jobs.ts`): `runAddMissingDefinitionsJobAsync`.

## UI (`cleanup-view.ts`)

- Replace the joined-id line with one row per package: id, `v<version>` or a reason sentence, the
  props file count, and a per-row **Add** button when actionable.
- Header button **Add definitions (N)** next to **Remove unused**, disabled with 0 actionable or while
  busy.
- Confirmation lists `id → version` and the files, notes the backups, then starts the job with
  cancel support (`cancelJobAsync`), status text and error line, and refreshes the report plus
  `cleanup-completed` on success.
- Non-actionable rows remain visible with their reason (they are still useful information).

## Tests

- `cpm-definitions.test.ts`: insert into an existing group; create a group; idempotent; already
  conditional; CRLF preservation; XML escaping; inline literal removed; condition/`$(`/not-found
  refused.
- Host (`host-api.test.ts`): only CPM projects count as missing; version from assets when the
  reference has none; `noVersion`/`multipleVersions`/`conditionalReference` reasons; one props file
  per project; add writes + backs up + restores + invalidates; rollback on restore failure; requested
  ids are re-validated.
- Webview (`cleanup-view.test.ts`): button disabled when nothing is actionable; confirmation; job
  call; refresh and status; reason text rendered.
- No C# changes (the only file mutation paths are host-side, like the existing conditional writer).

## Docs

- `README.md` → Cleanup section: the button and the reasons.
- `CHANGELOG.md` (Unreleased): `feat:` entry.

## Verification

`npm run typecheck`, `npm run lint`, focused host + component tests, then `npm run quality`.

## Out of scope

- Looking up a version from the feed; conditional CPM groups; consolidating multiple versions;
  adding entries for non-CPM projects.
