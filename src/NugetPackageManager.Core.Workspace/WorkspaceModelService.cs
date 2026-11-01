using System.Xml;
using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.Core.Workspace.Models;
using NugetPackageManager.Core.Workspace.Projects;
using NugetPackageManager.Core.Workspace.TargetFrameworks;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace;

/// <summary>
/// Builds the project model the Installed, Updates, Consolidate and Cleanup tabs consume.
///
/// The caller decides *which* files belong to the workspace (VS Code's globbing, solution
/// restriction and exclude settings live there); this service answers what each project contains.
/// </summary>
public sealed class WorkspaceModelService(
    TargetFrameworkResolver? frameworkResolver = null,
    ICpmEvaluator? cpmEvaluator = null) : IDisposable
{
    private const string PropertyReference = "$(";

    private readonly TargetFrameworkResolver frameworkResolver = frameworkResolver ?? new TargetFrameworkResolver();
    private readonly ICpmEvaluator cpmEvaluator = cpmEvaluator ?? new CpmEvaluator();
    private readonly bool ownsEvaluator = cpmEvaluator is null;
    private readonly Dictionary<string, CpmPackageMap> cpmCache = [];

    public async Task<IReadOnlyList<ProjectModel>> GetProjectsAsync(
        IReadOnlyList<string> projectPaths,
        IReadOnlyList<string>? extraTargetFrameworks,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(projectPaths);

        var overrides = extraTargetFrameworks ?? [];
        var projects = new List<ProjectModel>();

        foreach (var projectPath in projectPaths.Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (cancellationToken.IsCancellationRequested)
            {
                break;
            }

            try
            {
                projects.Add(await ParseProjectAsync(projectPath, overrides, cancellationToken).ConfigureAwait(false));
            }
            catch (Exception exception) when (exception is IOException or XmlException or UnauthorizedAccessException)
            {
                // One unreadable project must not fail the whole workspace scan.
            }
        }

        return [.. projects.OrderBy(project => project.Name, StringComparer.OrdinalIgnoreCase)];
    }

    /// <summary>
    /// Drops the evaluator's cached effective versions so the next scan re-runs MSBuild.
    ///
    /// The evaluator's stamp only covers the project, <c>Directory.Packages.props</c> and
    /// <c>Directory.Build.props</c>; a CPM write that edits a property in some other imported
    /// <c>.props</c> file therefore needs this explicit nudge. Only the evaluator this service
    /// created is invalidated — an injected fake is left alone.
    /// </summary>
    public void InvalidateVersionCache()
    {
        if (ownsEvaluator && cpmEvaluator is CpmEvaluator owned)
        {
            owned.ClearCache();
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
        var usesProperties = HasPropertyReferences(cpmMap);
        var flatMap = BuildFlatMap(cpmMap);

        CpmEvaluation? defaultEvaluation = null;
        if (usesProperties)
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

        var project = ProjectFileReader.Read(projectPath, flatMap) with { CpmEnabled = true };

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

        var effectiveByTfm = usesProperties
            ? await BuildEffectiveVersionsByTfmAsync(projectPath, defaultEvaluation, frameworks.Frameworks, cancellationToken)
                .ConfigureAwait(false)
            : null;

        return ApplyResolutions(project, cpmMap, frameworks.Frameworks, effectiveByTfm);
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

    private CpmPackageMap? LoadCpmMap(string projectPath)
    {
        var cpmFile = CpmPropsReader.FindCpmFile(projectPath);
        if (cpmFile is null || !CpmPropsReader.IsEnabled(projectPath, cpmFile))
        {
            return null;
        }

        if (cpmCache.TryGetValue(cpmFile, out var cached))
        {
            return cached;
        }

        var parsed = CpmPropsReader.Parse(File.ReadAllText(cpmFile));
        cpmCache[cpmFile] = parsed;
        return parsed;
    }

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
    }
}
