using System.Text.Json;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>
/// Reads the official restore output (<c>obj/project.assets.json</c>) and reports direct
/// references the graph already provides.
///
/// A direct reference is only safe to remove when removing it would not lower the resolved
/// version; one that raises a version is an intentional pin and is reported as such.
/// </summary>
public static class AssetsGraph
{
    private const string AssetsFileName = "project.assets.json";
    private const string PropsFileName = "Directory.Packages.props";

    /// <summary>Analyses a restored project, rejecting assets older than the inputs.</summary>
    public static DependencyAnalysis AnalyzeProject(string projectPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        try
        {
            var directory = Path.GetDirectoryName(projectPath) ?? string.Empty;
            var objDirectory = Path.Combine(directory, "obj");
            var assetsPath = Path.Combine(objDirectory, AssetsFileName);
            var assetsInfo = new FileInfo(assetsPath);
            var projectInfo = new FileInfo(projectPath);

            if (!assetsInfo.Exists || !projectInfo.Exists)
            {
                return Skipped("project has not been restored");
            }

            // `dotnet restore` is incremental: when the restore inputs are unchanged it updates
            // `project.nuget.cache` but leaves `project.assets.json` untouched. Comparing only
            // the assets timestamp therefore asked for a restore that could never change it.
            var restoreTime = assetsInfo.LastWriteTimeUtc;
            var cacheInfo = new FileInfo(Path.Combine(objDirectory, "project.nuget.cache"));
            if (cacheInfo.Exists && cacheInfo.LastWriteTimeUtc > restoreTime)
            {
                restoreTime = cacheInfo.LastWriteTimeUtc;
            }

            if (restoreTime < projectInfo.LastWriteTimeUtc)
            {
                return Skipped("assets are older than the project; restore first");
            }

            var propsInfo = new FileInfo(Path.Combine(directory, PropsFileName));
            if (propsInfo.Exists && restoreTime < propsInfo.LastWriteTimeUtc)
            {
                return Skipped("assets are older than Directory.Packages.props; restore first");
            }

            return new DependencyAnalysis
            {
                Issues = Analyze(File.ReadAllText(assetsPath), projectPath),
                Skipped = false,
            };
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return Skipped("project has not been restored");
        }
    }

    /// <summary>
    /// Direct references for every framework in the restored graph. A missing or unreadable
    /// assets file yields an empty result, which the preflight reads as "no direct section".
    /// </summary>
    public static RestoredDirectDependencies ReadDirectDependencies(string projectPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        try
        {
            var assetsPath = Path.Combine(
                Path.GetDirectoryName(projectPath) ?? string.Empty,
                "obj",
                AssetsFileName);

            return ReadDirectDependencies(Parse(File.ReadAllText(assetsPath)));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return new RestoredDirectDependencies
            {
                DirectByTfm = new Dictionary<string, List<string>>(StringComparer.Ordinal),
                HasDirectSection = false,
            };
        }
    }

    /// <summary>Splits <c>PackageId/1.2.3</c> into its parts.</summary>
    internal static (string Id, string Version)? SplitPackageKey(string key)
    {
        var separator = key.LastIndexOf('/');
        if (separator <= 0 || separator == key.Length - 1)
        {
            return null;
        }

        return (key[..separator], key[(separator + 1)..]);
    }

    internal static RestoredDirectDependencies ReadDirectDependencies(AssetsDocument assets)
    {
        var frameworks = assets.Project?.Frameworks;
        var direct = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        foreach (var (tfm, framework) in frameworks ?? [])
        {
            direct[tfm] = [.. (framework.Dependencies ?? [])
                .Where(entry => entry.Value.Target is null or "Package")
                .Select(entry => entry.Key.ToLowerInvariant())];
        }

        return new RestoredDirectDependencies
        {
            DirectByTfm = direct,
            HasDirectSection = direct.Count > 0,
        };
    }

    internal static IReadOnlyList<DependencyIssue> Analyze(string assetsJson, string projectPath)
    {
        var assets = Parse(assetsJson);
        var issues = new List<DependencyIssue>();

        foreach (var (tfm, target) in assets.Targets ?? [])
        {
            issues.AddRange(AnalyzeTarget(assets, tfm, target, projectPath));
        }

        return DedupeIssues(issues);
    }

    internal static AssetsDocument Parse(string json) =>
        JsonSerializer.Deserialize<AssetsDocument>(json) ?? new AssetsDocument();

    private static DependencyAnalysis Skipped(string reason) =>
        new()
        {
            Issues = [],
            Skipped = true,
            Reason = reason,
        };

    private static List<DependencyIssue> AnalyzeTarget(
        AssetsDocument assets,
        string tfm,
        Dictionary<string, AssetsTargetEntry> target,
        string projectPath)
    {
        var graph = BuildGraph(target);
        var directIds = DirectPackageIds(assets, tfm)
            .Where(graph.ContainsKey)
            .ToList();

        if (directIds.Count < 2)
        {
            return [];
        }

        var issues = new List<DependencyIssue>();
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var id in directIds)
        {
            var issue = BuildIssue(graph, directIds, id, seen, tfm, projectPath);
            if (issue is not null)
            {
                issues.Add(issue);
            }
        }

        return issues;
    }

    private static Dictionary<string, GraphNode> BuildGraph(
        Dictionary<string, AssetsTargetEntry> target)
    {
        var nodes = new Dictionary<string, GraphNode>(StringComparer.Ordinal);

        foreach (var (key, entry) in target)
        {
            if (entry.Type is not null and not "package")
            {
                continue;
            }

            if (SplitPackageKey(key) is not { } parts)
            {
                continue;
            }

            nodes[parts.Id] = new GraphNode
            {
                Id = parts.Id,
                Version = parts.Version,
                Dependencies = entry.Dependencies ?? [],
            };
        }

        return nodes;
    }

    private static List<string> DirectPackageIds(AssetsDocument assets, string tfm)
    {
        var dependencies = assets.Project?.Frameworks is { } frameworks
            && frameworks.TryGetValue(tfm, out var framework)
            ? framework.Dependencies
            : null;

        return [.. (dependencies ?? [])
            .Where(entry => entry.Value.Target is null or "Package")
            .Select(entry => entry.Key)];
    }

    private static DependencyIssue? BuildIssue(
        Dictionary<string, GraphNode> graph,
        List<string> directIds,
        string id,
        HashSet<string> seen,
        string tfm,
        string projectPath)
    {
        if (!graph.TryGetValue(id, out var node) || seen.Contains(id))
        {
            return null;
        }

        var chain = FindChain(graph, [.. directIds.Where(root => root != id)], id);
        if (chain is null)
        {
            return null;
        }

        seen.Add(id);

        var required = HighestRequiredVersion(graph, id);
        var isRedundant = required is not null && VersionSemantics.Compare(node.Version, required) <= 0;

        return new DependencyIssue
        {
            ProjectPath = projectPath,
            Tfm = tfm,
            PackageId = id,
            DirectVersion = node.Version,
            ResolvedVersion = node.Version,
            Kind = isRedundant ? "Redundant" : "Pinned",
            Chain = string.Join(" -> ", chain),
        };
    }

    /// <summary>Highest lower bound any edge in the graph requires for <paramref name="packageId"/>.</summary>
    private static string? HighestRequiredVersion(Dictionary<string, GraphNode> graph, string packageId)
    {
        string? highest = null;

        foreach (var node in graph.Values)
        {
            if (!node.Dependencies.TryGetValue(packageId, out var range))
            {
                continue;
            }

            var lower = VersionSemantics.RangeLowerBound(range);
            if (lower is null)
            {
                return null;
            }

            if (highest is null || VersionSemantics.Compare(lower, highest) > 0)
            {
                highest = lower;
            }
        }

        return highest;
    }

    /// <summary>Shortest chain of package ids from any of <paramref name="roots"/> to <paramref name="target"/>.</summary>
    private static List<string>? FindChain(
        Dictionary<string, GraphNode> graph,
        List<string> roots,
        string target)
    {
        var visited = new HashSet<string>(roots, StringComparer.Ordinal);
        var queue = new Queue<(string Id, List<string> Path)>(
            roots.Select(id => (id, new List<string> { id })));

        while (queue.Count > 0)
        {
            var (currentId, path) = queue.Dequeue();
            if (!graph.TryGetValue(currentId, out var node))
            {
                continue;
            }

            foreach (var dependencyId in node.Dependencies.Keys)
            {
                if (dependencyId == target)
                {
                    return [.. path, dependencyId];
                }

                if (!visited.Add(dependencyId))
                {
                    continue;
                }

                queue.Enqueue((dependencyId, [.. path, dependencyId]));
            }
        }

        return null;
    }

    /// <summary>One row per package; prefer the Redundant verdict when two frameworks disagree.</summary>
    private static List<DependencyIssue> DedupeIssues(List<DependencyIssue> issues)
    {
        var byPackage = new Dictionary<string, DependencyIssue>(StringComparer.Ordinal);

        foreach (var issue in issues)
        {
            if (!byPackage.TryGetValue(issue.PackageId, out var existing)
                || (existing.Kind == "Pinned" && issue.Kind == "Redundant"))
            {
                byPackage[issue.PackageId] = issue;
            }
        }

        return [.. byPackage.Values
            .OrderBy(issue => issue.PackageId, StringComparer.InvariantCulture)];
    }

    private sealed class GraphNode
    {
        public required string Id { get; init; }

        public required string Version { get; init; }

        public required Dictionary<string, string> Dependencies { get; init; }
    }
}
