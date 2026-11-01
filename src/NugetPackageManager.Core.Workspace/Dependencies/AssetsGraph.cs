using System.Text.Json;
using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>One row of the dependency-issue report (<c>DependencyIssue</c> in the host).</summary>
public sealed record DependencyIssueDto
{
    [JsonPropertyName("ProjectPath")]
    public required string ProjectPath { get; init; }

    [JsonPropertyName("Tfm")]
    public required string Tfm { get; init; }

    [JsonPropertyName("PackageId")]
    public required string PackageId { get; init; }

    [JsonPropertyName("DirectVersion")]
    public required string DirectVersion { get; init; }

    [JsonPropertyName("ResolvedVersion")]
    public required string ResolvedVersion { get; init; }

    /// <summary><c>Redundant</c> or <c>Pinned</c>.</summary>
    [JsonPropertyName("Kind")]
    public required string Kind { get; init; }

    [JsonPropertyName("Chain")]
    public required string Chain { get; init; }
}

/// <summary>Result of analysing one project's restored graph.</summary>
public sealed record DependencyAnalysis
{
    [JsonPropertyName("Issues")]
    public required IReadOnlyList<DependencyIssueDto> Issues { get; init; }

    [JsonPropertyName("Skipped")]
    public required bool Skipped { get; init; }

    [JsonPropertyName("Reason")]
    public string? Reason { get; init; }
}

/// <summary>
/// The direct references and framework list of a restored project, for the batch preflight.
/// Ids are lower-cased, as the host's previous reader did.
/// </summary>
public sealed record RestoredDirectDependencies
{
    [JsonPropertyName("DirectByTfm")]
    public required IReadOnlyDictionary<string, List<string>> DirectByTfm { get; init; }

    [JsonPropertyName("HasDirectSection")]
    public required bool HasDirectSection { get; init; }
}

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
            var assetsPath = Path.Combine(directory, "obj", AssetsFileName);
            var assetsInfo = new FileInfo(assetsPath);
            var projectInfo = new FileInfo(projectPath);

            if (!assetsInfo.Exists || !projectInfo.Exists)
            {
                return Skipped("project has not been restored");
            }

            if (assetsInfo.LastWriteTimeUtc < projectInfo.LastWriteTimeUtc)
            {
                return Skipped("assets are older than the project; restore first");
            }

            var propsInfo = new FileInfo(Path.Combine(directory, PropsFileName));
            if (propsInfo.Exists && assetsInfo.LastWriteTimeUtc < propsInfo.LastWriteTimeUtc)
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

    internal static IReadOnlyList<DependencyIssueDto> Analyze(string assetsJson, string projectPath)
    {
        var assets = Parse(assetsJson);
        var issues = new List<DependencyIssueDto>();

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

    private static List<DependencyIssueDto> AnalyzeTarget(
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

        var issues = new List<DependencyIssueDto>();
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

    private static DependencyIssueDto? BuildIssue(
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

        return new DependencyIssueDto
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
    private static List<DependencyIssueDto> DedupeIssues(List<DependencyIssueDto> issues)
    {
        var byPackage = new Dictionary<string, DependencyIssueDto>(StringComparer.Ordinal);

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

/// <summary>The subset of <c>project.assets.json</c> the analysis needs.</summary>
public sealed class AssetsDocument
{
    [JsonPropertyName("targets")]
    public Dictionary<string, Dictionary<string, AssetsTargetEntry>>? Targets { get; init; }

    [JsonPropertyName("project")]
    public AssetsProject? Project { get; init; }
}

public sealed class AssetsProject
{
    [JsonPropertyName("frameworks")]
    public Dictionary<string, AssetsProjectFramework>? Frameworks { get; init; }
}

public sealed class AssetsProjectFramework
{
    [JsonPropertyName("dependencies")]
    public Dictionary<string, AssetsDirectDependency>? Dependencies { get; init; }
}

public sealed class AssetsDirectDependency
{
    [JsonPropertyName("target")]
    public string? Target { get; init; }

    [JsonPropertyName("version")]
    public string? Version { get; init; }
}

public sealed class AssetsTargetEntry
{
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("dependencies")]
    public Dictionary<string, string>? Dependencies { get; init; }
}
