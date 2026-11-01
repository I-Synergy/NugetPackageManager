using System.Xml;
using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.Core.Workspace.Models;
using NugetPackageManager.Core.Workspace.Projects;
using NugetPackageManager.Core.Workspace.TargetFrameworks;

namespace NugetPackageManager.Core.Workspace;

/// <summary>
/// Builds the project model the Installed, Updates, Consolidate and Cleanup tabs consume.
///
/// The caller decides *which* files belong to the workspace (VS Code's globbing, solution
/// restriction and exclude settings live there); this service answers what each project contains.
/// </summary>
public sealed class WorkspaceModelService(TargetFrameworkResolver? frameworkResolver = null) : IDisposable
{
    private readonly TargetFrameworkResolver frameworkResolver = frameworkResolver ?? new TargetFrameworkResolver();
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

    private async Task<ProjectModel> ParseProjectAsync(
        string projectPath,
        IReadOnlyList<string> overrides,
        CancellationToken cancellationToken)
    {
        var cpmMap = LoadCpmMap(projectPath);

        var project = ProjectFileReader.Read(projectPath, cpmMap is null ? null : BuildFlatMap(cpmMap)) with
        {
            CpmEnabled = cpmMap is not null,
        };

        if (cpmMap is not { HasConditionalGroups: true })
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

        return ApplyResolutions(project, cpmMap, frameworks.Frameworks);
    }

    /// <summary>One row per version line; a single distinct version also fills <c>Version</c>.</summary>
    internal static ProjectModel ApplyResolutions(ProjectModel project, CpmPackageMap map, IReadOnlyList<string> tfms)
    {
        ArgumentNullException.ThrowIfNull(project);
        ArgumentNullException.ThrowIfNull(map);

        var packageIds = project.Packages.Select(package => package.Id).ToList();
        var resolutions = CpmPropsReader.ResolveVersions(map, packageIds, tfms);

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

    public void Dispose() => frameworkResolver.Dispose();
}
