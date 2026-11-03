using System.Collections.Concurrent;
using System.Xml;
using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.Core.Workspace.Models;
using NugetPackageManager.Core.Workspace.Projects;
using NugetPackageManager.Core.Workspace.TargetFrameworks;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace;

/// <summary>
/// One project finished: <c>Completed</c> of <c>Total</c> distinct projects, and which one.
/// </summary>
public sealed record ProjectParseProgress(string ProjectPath, int Completed, int Total);

/// <summary>
/// Builds the project model the Installed, Updates, Consolidate and Cleanup tabs consume.
///
/// The caller decides *which* files belong to the workspace (VS Code's globbing, solution
/// restriction and exclude settings live there); this service answers what each project contains.
/// </summary>
public sealed class WorkspaceModelService(
    TargetFrameworkResolver? frameworkResolver = null,
    ICpmEvaluator? cpmEvaluator = null,
    int? parseConcurrency = null,
    CpmPropertyResolver? cpmPropertyResolver = null) : IDisposable
{
    private const string PropertyReference = "$(";

    private static readonly int defaultParseConcurrency = Math.Clamp(Environment.ProcessorCount, 2, 16);

    private readonly TargetFrameworkResolver frameworkResolver = frameworkResolver ?? new TargetFrameworkResolver();
    private readonly ICpmEvaluator cpmEvaluator = cpmEvaluator ?? new CpmEvaluator();
    private readonly bool ownsEvaluator = cpmEvaluator is null;
    private readonly CpmPropertyResolver propertyResolver = cpmPropertyResolver ?? new CpmPropertyResolver();
    private readonly bool ownsPropertyResolver = cpmPropertyResolver is null;
    private readonly int projectsInFlight = ValidateConcurrency(parseConcurrency);
    private readonly ConcurrentDictionary<string, CachedCpmMap> cpmCache = new(StringComparer.Ordinal);

    /// <summary>
    /// Parses every distinct project in parallel and returns them sorted by file name.
    ///
    /// The parallelism is set by the <c>parseConcurrency</c> constructor argument; the MSBuild
    /// spawns those parses can trigger are bounded separately by
    /// <see cref="NugetPackageManager.Core.Workspace.Infrastructure.MsBuildProcessGate"/>. One
    /// unreadable project (<see cref="IOException"/>, <see cref="XmlException"/> or
    /// <see cref="UnauthorizedAccessException"/>) is skipped so the rest of the workspace still
    /// loads; cancellation propagates as <see cref="OperationCanceledException"/>.
    /// </summary>
    /// <param name="projectPaths">The discovered project files; duplicates are collapsed.</param>
    /// <param name="extraTargetFrameworks">Target frameworks the caller wants evaluated as well.</param>
    /// <param name="cancellationToken">Aborts the whole scan.</param>
    /// <param name="progress">
    /// Optional per-project progress. Nothing is reported when it is null; otherwise one report is
    /// emitted per finished project (parsed or skipped), with <c>Completed</c> running 1..N and
    /// <c>Total</c> the distinct-path count.
    /// </param>
    public async Task<IReadOnlyList<ProjectModel>> GetProjectsAsync(
        IReadOnlyList<string> projectPaths,
        IReadOnlyList<string>? extraTargetFrameworks,
        CancellationToken cancellationToken,
        IProgress<ProjectParseProgress>? progress = null)
    {
        ArgumentNullException.ThrowIfNull(projectPaths);

        var overrides = extraTargetFrameworks ?? [];
        var distinctPaths = projectPaths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var projects = new ConcurrentBag<ProjectModel>();
        var completed = 0;

        await Parallel.ForEachAsync(
            distinctPaths,
            new ParallelOptions
            {
                MaxDegreeOfParallelism = projectsInFlight,
                CancellationToken = cancellationToken,
            },
            async (projectPath, token) =>
            {
                try
                {
                    projects.Add(await ParseProjectAsync(projectPath, overrides, token).ConfigureAwait(false));
                }
                catch (Exception exception) when (exception is IOException or XmlException or UnauthorizedAccessException)
                {
                    // One unreadable project must not fail the whole workspace scan.
                }

                if (progress is not null)
                {
                    // IProgress<T>.Report is thread-safe, so the counter is all that needs ordering.
                    progress.Report(new ProjectParseProgress(
                        projectPath,
                        Interlocked.Increment(ref completed),
                        distinctPaths.Length));
                }
            }).ConfigureAwait(false);

        // Path is the tie-break so projects that share a file name keep a stable order.
        return [.. projects
            .OrderBy(project => project.Name, StringComparer.OrdinalIgnoreCase)
            .ThenBy(project => project.Path, StringComparer.OrdinalIgnoreCase)];
    }

    private static int ValidateConcurrency(int? parseConcurrency)
    {
        if (parseConcurrency is null)
        {
            return defaultParseConcurrency;
        }

        if (parseConcurrency < 1)
        {
            throw new ArgumentOutOfRangeException(
                nameof(parseConcurrency),
                parseConcurrency,
                "Parallelism must be at least 1.");
        }

        return parseConcurrency.Value;
    }

    /// <summary>
    /// Drops the evaluator's, the property resolver's and the CPM props map's cached state so the
    /// next scan re-runs MSBuild, re-reads the props/import chain and re-parses
    /// <c>Directory.Packages.props</c>.
    ///
    /// The evaluator's stamp only covers the project, <c>Directory.Packages.props</c> and
    /// <c>Directory.Build.props</c>; a CPM write that edits a property in some other imported
    /// <c>.props</c> file therefore needs this explicit nudge. Clearing the props map cache as well
    /// makes a write made through the extension visible even when the filesystem timestamp is too
    /// coarse to change. Only the evaluator and the resolver this service created are invalidated —
    /// an injected fake is left alone.
    /// </summary>
    public void InvalidateVersionCache()
    {
        cpmCache.Clear();

        if (ownsEvaluator && cpmEvaluator is CpmEvaluator owned)
        {
            owned.ClearCache();
        }

        if (ownsPropertyResolver)
        {
            propertyResolver.ClearCache();
        }
    }

    private async Task<ProjectModel> ParseProjectAsync(
        string projectPath,
        IReadOnlyList<string> overrides,
        CancellationToken cancellationToken)
    {
        var cpmMap = LoadCpmMap(projectPath);
        return cpmMap is null
            ? await ParseNonCpmProjectAsync(projectPath, cancellationToken).ConfigureAwait(false)
            : await ParseCpmProjectAsync(projectPath, cpmMap, overrides, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ProjectModel> ParseNonCpmProjectAsync(string projectPath, CancellationToken cancellationToken)
    {
        var project = ProjectFileReader.Read(projectPath) with { CpmEnabled = false };

        if (project.Packages.Any(package => package.Version.Contains(PropertyReference, StringComparison.Ordinal)))
        {
            var evaluation = await cpmEvaluator
                .EvaluateAsync(projectPath, targetFramework: null, cancellationToken)
                .ConfigureAwait(false);

            if (evaluation is not null)
            {
                project = ProjectFileReader.Read(projectPath, null, evaluation.PackageReferences) with
                {
                    CpmEnabled = false,
                };
            }
        }

        return project with { TargetFrameworks = [], TfmSource = "xml" };
    }

    private async Task<ProjectModel> ParseCpmProjectAsync(
        string projectPath,
        CpmPackageMap cpmMap,
        IReadOnlyList<string> overrides,
        CancellationToken cancellationToken)
    {
        // One cheap XML read settles whether *this* project needs MSBuild: a project whose
        // referenced ids all have literal versions after (possibly partial) property resolution
        // must not pay for an evaluation only because some other package's property is undefined.
        var references = ProjectFileReader.Read(projectPath);
        var needsEvaluation = NeedsEvaluation(cpmMap, references);
        var flatMap = BuildFlatMap(cpmMap);

        CpmEvaluation? defaultEvaluation = null;
        if (needsEvaluation)
        {
            // One evaluation with no TargetFramework supplies the flat map ProjectFileReader uses.
            defaultEvaluation = await cpmEvaluator
                .EvaluateAsync(projectPath, targetFramework: null, cancellationToken)
                .ConfigureAwait(false);
            if (defaultEvaluation is not null)
            {
                flatMap = MergeEvaluatedVersions(flatMap, defaultEvaluation.CentralVersions);
            }
        }

        // A `$(…)` in the project itself (a `Version` or `VersionOverride`) can only be expanded by
        // the evaluation, so its resolved reference is handed to the reader just like the non-CPM
        // path does; without an evaluation the raw text survives unchanged.
        var project = ProjectFileReader.Read(projectPath, flatMap, defaultEvaluation?.PackageReferences) with
        {
            CpmEnabled = true,
        };

        if (!cpmMap.HasConditionalGroups)
        {
            // No conditional versions means no reason to spend a `dotnet msbuild` call.
            return project with { TargetFrameworks = [], TfmSource = "xml" };
        }

        var frameworks = await frameworkResolver
            .GetTargetFrameworksAsync(projectPath, overrides, cancellationToken)
            .ConfigureAwait(false);

        project = project with
        {
            TargetFrameworks = frameworks.Frameworks,
            TfmSource = SourceName(frameworks.Source),
        };

        var effectiveByTfm = needsEvaluation
            ? await BuildEffectiveVersionsByTfmAsync(projectPath, defaultEvaluation, frameworks.Frameworks, cancellationToken)
                .ConfigureAwait(false)
            : null;

        return ApplyResolutions(project, cpmMap, frameworks.Frameworks, effectiveByTfm);
    }

    /// <summary>
    /// True when this project's versions cannot be read from XML alone: one of the ids it references
    /// still carries a <c>$(…)</c> version in the map (unconditional or any conditional entry), or
    /// the project itself writes a <c>$(…)</c> version (or <c>VersionOverride</c>).
    ///
    /// The map may be partially resolved, so the answer is per project: a package whose property the
    /// resolver could not follow only costs the projects that actually reference it.
    /// </summary>
    /// <param name="map">The (possibly partially resolved) central package map.</param>
    /// <param name="project">The project as read without the map, so versions are still raw.</param>
    private static bool NeedsEvaluation(CpmPackageMap map, ProjectModel project)
    {
        foreach (var package in project.Packages)
        {
            if (IsPropertyVersion(package.Version))
            {
                return true;
            }

            if (MapVersionIsProperty(map, package.Id))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>True when any version line of the map for <paramref name="packageId"/> is a property.</summary>
    private static bool MapVersionIsProperty(CpmPackageMap map, string packageId)
    {
        var version = FindVersion(map.Unconditional, packageId);
        if (version is not null)
        {
            return IsPropertyVersion(version);
        }

        foreach (var entry in map.Conditional)
        {
            version = FindVersion(entry.Versions, packageId);
            if (version is not null && IsPropertyVersion(version))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Case-insensitive version lookup, matching how the map itself is consulted.</summary>
    private static string? FindVersion(Dictionary<string, string> versions, string packageId)
    {
        if (versions.TryGetValue(packageId, out var exact))
        {
            return exact;
        }

        foreach (var (key, value) in versions)
        {
            if (string.Equals(key, packageId, StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }
        }

        return null;
    }

    private async Task<Dictionary<string, IReadOnlyDictionary<string, string>>> BuildEffectiveVersionsByTfmAsync(
        string projectPath,
        CpmEvaluation? defaultEvaluation,
        IReadOnlyList<string> tfms,
        CancellationToken cancellationToken)
    {
        var byTfm = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal);
        if (defaultEvaluation is not null)
        {
            byTfm[string.Empty] = defaultEvaluation.CentralVersions;
        }

        foreach (var tfm in tfms)
        {
            var evaluation = await cpmEvaluator
                .EvaluateAsync(projectPath, tfm, cancellationToken)
                .ConfigureAwait(false);
            if (evaluation is not null)
            {
                byTfm[tfm] = evaluation.CentralVersions;
            }
        }

        return byTfm;
    }

    /// <summary>One row per version line; a single distinct version also fills <c>Version</c>.</summary>
    internal static ProjectModel ApplyResolutions(
        ProjectModel project,
        CpmPackageMap map,
        IReadOnlyList<string> tfms,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? effectiveVersionsByTfm = null)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(map);

        var packageIds = project.Packages.Select(package => package.Id).ToList();
        var resolutions = CpmPropsReader.ResolveVersions(map, packageIds, tfms, effectiveVersionsByTfm);

        var packages = new List<ProjectPackageModel>(project.Packages.Count);
        foreach (var package in project.Packages)
        {
            if (!resolutions.TryGetValue(package.Id, out var resolved) || resolved.Count == 0)
            {
                packages.Add(package);
                continue;
            }

            var conditional = resolved.Find(item => item.Condition.Length > 0);
            var distinctVersions = resolved.Select(item => item.Version).Distinct(StringComparer.Ordinal).ToList();

            packages.Add(package with
            {
                CpmResolutions = [.. resolved
                    .Select(item => new CpmResolutionModel
                    {
                        Tfm = item.Tfm,
                        Version = item.Version,
                        Condition = item.Condition,
                        ConditionLabel = item.ConditionLabel,
                        Matched = item.Matched,
                    })],
                CpmFramework = conditional?.ConditionLabel,
                Version = distinctVersions.Count == 1 ? distinctVersions[0] : package.Version,
            });
        }

        return project with { Packages = packages };
    }

    /// <summary>
    /// Returns the parsed central package map for <paramref name="projectPath"/>, caching it per
    /// props file until the file's last-write time or length changes. The stamp makes external
    /// edits — and the extension's own writes — visible without a sidecar restart.
    /// </summary>
    private CpmPackageMap? LoadCpmMap(string projectPath)
    {
        var cpmFile = CpmPropsReader.FindCpmFile(projectPath);
        if (cpmFile is null || !CpmPropsReader.IsEnabled(projectPath, cpmFile))
        {
            return null;
        }

        // A fresh FileInfo per call: a cached instance would keep the stamp it was created with.
        var stamp = new FileInfo(cpmFile);
        if (cpmCache.TryGetValue(cpmFile, out var cached)
            && cached.Length == stamp.Length
            && cached.LastWriteUtc == stamp.LastWriteTimeUtc)
        {
            return cached.Map;
        }

        var parsed = ResolvePropertyVersions(cpmFile, CpmPropsReader.Parse(File.ReadAllText(cpmFile)));
        cpmCache[cpmFile] = new CachedCpmMap(parsed, stamp.Length, stamp.LastWriteTimeUtc);
        return parsed;
    }

    /// <summary>
    /// Replaces property-based versions with their literal definitions when the props/import chain
    /// can be read without MSBuild. The resolver substitutes every property it can and leaves the
    /// rest exactly as written, so a partially resolved map still carries the full set of versions
    /// and only the packages that keep a <c>$(</c> cost an evaluation.
    /// </summary>
    private CpmPackageMap ResolvePropertyVersions(string cpmFile, CpmPackageMap parsed) =>
        HasPropertyReferences(parsed)
            ? propertyResolver.TryResolve(cpmFile, parsed) ?? parsed
            : parsed;

    private sealed record CachedCpmMap(CpmPackageMap Map, long Length, DateTime LastWriteUtc);

    /// <summary>True when any version line (unconditional or conditional) references a property.</summary>
    private static bool HasPropertyReferences(CpmPackageMap map) =>
        map.Unconditional.Values.Any(IsPropertyVersion)
        || map.Conditional.Any(entry => entry.Versions.Values.Any(IsPropertyVersion));

    private static bool IsPropertyVersion(string version) =>
        version.Contains(PropertyReference, StringComparison.Ordinal);

    /// <summary>Replaces property-based flat values with the evaluated version when one is known.</summary>
    private static Dictionary<string, string> MergeEvaluatedVersions(
        Dictionary<string, string> flat,
        IReadOnlyDictionary<string, string> evaluated)
    {
        var merged = new Dictionary<string, string>(flat, StringComparer.Ordinal);
        foreach (var (packageId, version) in flat)
        {
            if (IsPropertyVersion(version)
                && evaluated.TryGetValue(packageId, out var effective)
                && !string.IsNullOrEmpty(effective))
            {
                merged[packageId] = effective;
            }
        }

        return merged;
    }

    /// <summary>Unconditional versions first, then the first conditional value per package.</summary>
    internal static Dictionary<string, string> BuildFlatMap(CpmPackageMap map)
    {
        ArgumentNullException.ThrowIfNull(map);

        var flat = new Dictionary<string, string>(map.Unconditional, StringComparer.Ordinal);

        foreach (var entry in map.Conditional)
        {
            foreach (var (packageId, version) in entry.Versions)
            {
                flat.TryAdd(packageId, version);
            }
        }

        return flat;
    }

    private static string SourceName(TargetFrameworkSource source) => source switch
    {
        TargetFrameworkSource.MsBuild => "msbuild",
        TargetFrameworkSource.Assets => "assets",
        TargetFrameworkSource.Override => "override",
        TargetFrameworkSource.Xml => "xml",
        _ => "xml",
    };

    public void Dispose()
    {
        frameworkResolver.Dispose();
        if (ownsEvaluator)
        {
            (cpmEvaluator as IDisposable)?.Dispose();
        }

        if (ownsPropertyResolver)
        {
            propertyResolver.Dispose();
        }
    }
}
