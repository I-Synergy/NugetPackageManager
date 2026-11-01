using System.Text.Json;
using NuGet.Frameworks;
using NuGet.Versioning;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace.Dependencies;

namespace NugetPackageManager.Core;

/// <summary>
/// Dependency operations the host needs as a whole: the restored-graph analysis, the restored
/// direct references used by the batch preflight, the requirement closure and its apply order.
/// The host never crosses the process boundary for a single version comparison.
/// </summary>
public sealed class DependencyHandlers
{
    private readonly INuGetSourceProvider sources;

    public DependencyHandlers(INuGetSourceProvider sources)
    {
        ArgumentNullException.ThrowIfNull(sources);
        this.sources = sources;
    }

    public Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["analyzeProjectDependencies"] = HandleAnalyzeProjectAsync,
            ["getRestoredDirectDependencies"] = HandleGetRestoredDirectDependenciesAsync,
            ["computeRequirementClosure"] = HandleComputeRequirementClosureAsync,
            ["orderRequirements"] = HandleOrderRequirementsAsync,
        };

    private Task<object?> HandleAnalyzeProjectAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        var projectPath = ReadRequiredString(parameters, "projectPath");
        return Task.FromResult<object?>(AssetsGraph.AnalyzeProject(projectPath));
    }

    private Task<object?> HandleGetRestoredDirectDependenciesAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;
        var projectPath = ReadRequiredString(parameters, "projectPath");
        return Task.FromResult<object?>(AssetsGraph.ReadDirectDependencies(projectPath));
    }

    private async Task<object?> HandleComputeRequirementClosureAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var descriptors = ReadSources(parameters);
        var selected = ReadSelected(parameters);
        var tfms = ReadStringArray(parameters, "tfms");
        var effective = ReadVersionMap(parameters, "effective");
        var constrained = ReadStringListMap(parameters, "constrained");
        var constrainAll = ReadBoolean(parameters, "constrainAll");
        var maxInspected = ReadInt32(parameters, "maxInspected");

        return await RequirementClosure.ComputeAsync(
            selected,
            tfms,
            effective,
            (id, version, tfm, ct) => LookupDependenciesAsync(descriptors, id, version, tfm, ct),
            (id, tfm) => constrainAll
                || (constrained.TryGetValue(tfm, out var ids)
                    && Enumerable.Contains(ids, id, StringComparer.OrdinalIgnoreCase)),
            maxInspected == 0 ? RequirementClosure.DefaultMaxInspected : maxInspected,
            cancellationToken).ConfigureAwait(false);
    }

    private static Task<object?> HandleOrderRequirementsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        return Task.FromResult<object?>(new
        {
            orders = RequirementClosure.Order(ReadConflicts(parameters)),
        });
    }

    /// <summary>
    /// Resolves one package version's declared dependencies. Sources are tried in order, as the
    /// host did; a feed that cannot answer is skipped rather than failing the whole preflight.
    /// </summary>
    private async Task<IReadOnlyList<ClosureDependency>?> LookupDependenciesAsync(
        IReadOnlyList<SourceDescriptor> descriptors,
        string id,
        string version,
        string tfm,
        CancellationToken cancellationToken)
    {
        if (!NuGetVersion.TryParse(version, out var wanted))
        {
            return null;
        }

        foreach (var descriptor in descriptors)
        {
            try
            {
                var source = sources.GetSource(descriptor);
                var package = await source.GetPackageAsync(id, prerelease: true, cancellationToken)
                    .ConfigureAwait(false);

                var versionReference = package.Versions.FirstOrDefault(entry =>
                    NuGetVersion.TryParse(entry.Version, out var candidate)
                    && candidate.CompareTo(wanted) == 0);

                if (versionReference is null)
                {
                    continue;
                }

                var details = await source.GetPackageDetailsAsync(versionReference.Id, cancellationToken)
                    .ConfigureAwait(false);

                var dependencies = SelectDependencyGroup(details.Dependencies.Frameworks, tfm);
                return dependencies?
                    .Select(dependency => new ClosureDependency(dependency.Package, dependency.VersionRange))
                    .ToList();
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                // Try the next source; metadata being unavailable is "no constraint", not a
                // failed preflight.
            }
        }

        return null;
    }

    /// <summary>
    /// The dependency group that applies to <paramref name="tfm"/>: an exact (case-insensitive)
    /// group first, then the same major line of another <c>net</c> framework.
    /// </summary>
    private static List<PackageDependencyDto>? SelectDependencyGroup(
        Dictionary<string, List<PackageDependencyDto>> frameworks,
        string tfm)
    {
        if (frameworks.Count == 0)
        {
            return null;
        }

        foreach (var (key, value) in frameworks)
        {
            if (string.Equals(key, tfm, StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }
        }

        var major = TfmMajor(tfm);
        if (major is null)
        {
            return null;
        }

        foreach (var (key, value) in frameworks)
        {
            if (key.StartsWith("net", StringComparison.OrdinalIgnoreCase) && TfmMajor(key) == major)
            {
                return value;
            }
        }

        return null;
    }

    private static int? TfmMajor(string tfm)
    {
        NuGetFramework framework;
        try
        {
            framework = NuGetFramework.Parse(tfm);
        }
        catch (ArgumentException)
        {
            return null;
        }

        return !framework.IsUnsupported
            && string.Equals(
                framework.Framework,
                FrameworkConstants.FrameworkIdentifiers.NetCoreApp,
                StringComparison.Ordinal)
            && framework.Version.Major > 0
                ? framework.Version.Major
                : null;
    }

    private static List<SourceDescriptor> ReadSources(JsonElement parameters)
    {
        var sources = new List<SourceDescriptor>();

        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("sources", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return sources;
        }

        foreach (var element in array.EnumerateArray())
        {
            var url = ReadOptionalString(element, "url");
            if (string.IsNullOrWhiteSpace(url))
            {
                continue;
            }

            sources.Add(new SourceDescriptor
            {
                Url = url,
                Username = ReadOptionalString(element, "username"),
                Password = ReadOptionalString(element, "password"),
                Proxy = ReadOptionalString(element, "proxy"),
            });
        }

        return sources;
    }

    private static List<SelectedPackage> ReadSelected(JsonElement parameters) =>
        [.. ReadArray(parameters, "selected")
            .Select(element => new SelectedPackage(
                ReadOptionalString(element, "id") ?? string.Empty,
                ReadOptionalString(element, "version") ?? string.Empty))
            .Where(package => package.Id.Length > 0 && package.Version.Length > 0)];

    private static List<string> ReadStringArray(JsonElement parameters, string property) =>
        [.. ReadArray(parameters, property)
            .Select(element => element.ValueKind == JsonValueKind.String ? element.GetString() : null)
            .Where(value => !string.IsNullOrEmpty(value))
            .Select(value => value!)];

    private static Dictionary<string, string> ReadVersionMap(JsonElement parameters, string property)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        if (parameters.ValueKind == JsonValueKind.Object
            && parameters.TryGetProperty(property, out var map)
            && map.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in map.EnumerateObject())
            {
                if (entry.Value.ValueKind == JsonValueKind.String)
                {
                    result[entry.Name] = entry.Value.GetString() ?? string.Empty;
                }
            }
        }

        return result;
    }

    private static Dictionary<string, List<string>> ReadStringListMap(
        JsonElement parameters,
        string property)
    {
        var result = new Dictionary<string, List<string>>(StringComparer.Ordinal);

        if (parameters.ValueKind == JsonValueKind.Object
            && parameters.TryGetProperty(property, out var map)
            && map.ValueKind == JsonValueKind.Object)
        {
            foreach (var entry in map.EnumerateObject())
            {
                result[entry.Name] = entry.Value.ValueKind == JsonValueKind.Array
                    ? [.. entry.Value.EnumerateArray()
                        .Where(value => value.ValueKind == JsonValueKind.String)
                        .Select(value => value.GetString() ?? string.Empty)]
                    : [];
            }
        }

        return result;
    }

    private static List<ClosureConflict> ReadConflicts(JsonElement parameters) =>
        [.. ReadArray(parameters, "conflicts")
            .Select(element => new ClosureConflict
            {
                PackageId = ReadOptionalString(element, "packageId") ?? string.Empty,
                RequiredBy = ReadOptionalString(element, "requiredBy") ?? string.Empty,
                RequiredByVersion = ReadOptionalString(element, "requiredByVersion") ?? string.Empty,
                Range = ReadOptionalString(element, "range") ?? string.Empty,
                RequiredVersion = ReadOptionalString(element, "requiredVersion") ?? string.Empty,
                Tfm = ReadOptionalString(element, "tfm") ?? string.Empty,
            })
            .Where(conflict => conflict.PackageId.Length > 0 && conflict.RequiredBy.Length > 0)];

    private static List<JsonElement> ReadArray(JsonElement parameters, string property) =>
        parameters.ValueKind == JsonValueKind.Object
        && parameters.TryGetProperty(property, out var array)
        && array.ValueKind == JsonValueKind.Array
            ? [.. array.EnumerateArray()]
            : [];

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException("invalidParams", $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ReadBoolean(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.True;

    private static int ReadInt32(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var parsed)
            ? parsed
            : 0;
}
