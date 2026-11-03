using System.Text.Json;
using System.Text.Json.Serialization;
using NugetPackageManager.Common;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;
using NugetPackageManager.Core.Workspace.Tools;

namespace NugetPackageManager.Core;

/// <summary>
/// The local .NET tool operations the host drives: read every
/// <c>.config/dotnet-tools.json</c> in the workspace with the latest eligible version per tool,
/// and pin one tool at a new version.
///
/// The host still owns every <c>dotnet</c> spawn (<c>dotnet tool list --local</c>,
/// <c>dotnet tool restore</c>) and the workspace-path rules it applies to other writes; the
/// manifest path is validated here as well, because this handler edits a file.
/// </summary>
public sealed class ToolHandlers
{
    private readonly INuGetSourceProvider sources;

    public ToolHandlers(INuGetSourceProvider sources)
    {
        ArgumentNullException.ThrowIfNull(sources);

        this.sources = sources;
    }

    public Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["readLocalTools"] = HandleReadLocalToolsAsync,
            ["updateLocalTool"] = HandleUpdateLocalToolAsync,
        };

    /// <summary>
    /// Reads the workspace's manifests. <c>resolveLatest: false</c> answers from the manifests
    /// alone — no source is contacted — so the host can re-render while offline.
    /// </summary>
    private async Task<object?> HandleReadLocalToolsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");
        var projectPaths = ReadStringArray(parameters, "projectPaths");
        var prerelease = ReadBoolean(parameters, "prerelease");
        var resolveLatest = ReadBoolean(parameters, "resolveLatest", fallback: true);
        var forceRefresh = ReadBoolean(parameters, "forceRefresh");

        if (workspaceRoots.Count == 0)
        {
            return new GetLocalToolsResponse { Manifests = [] };
        }

        if (forceRefresh)
        {
            sources.ClearPackageCaches();
        }

        var manifestPaths = LocalToolManifestLocator.FindManifests(
            workspaceRoots, projectPaths, cancellationToken);

        var resolver = resolveLatest
            ? new LocalToolOutdatedResolver(
                new NuGetVersionSource(sources, ReadSources(parameters)),
                prerelease)
            : null;

        var manifests = new List<LocalToolManifestInfo>(manifestPaths.Count);
        foreach (var manifestPath in manifestPaths)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var document = await LocalToolManifestReader
                .ReadAsync(manifestPath, cancellationToken)
                .ConfigureAwait(false);

            var tools = new List<LocalToolInfo>(document.Tools.Count);
            foreach (var tool in document.Tools)
            {
                var outdated = resolver is null
                    ? new LocalToolOutdatedResult()
                    : await resolver.ResolveAsync(tool.Id, tool.Version, cancellationToken).ConfigureAwait(false);

                tools.Add(new LocalToolInfo
                {
                    Id = tool.Id,
                    Commands = tool.Commands,
                    Version = tool.Version,
                    Pinned = tool.Pinned,
                    LatestVersion = outdated.LatestVersion,
                    UpdateAvailable = outdated.UpdateAvailable,
                    // Restore state is machine state: the host probes it and fills it in.
                    NotRestored = false,
                });
            }

            manifests.Add(new LocalToolManifestInfo
            {
                Path = document.Path,
                IsRoot = document.IsRoot,
                Tools = tools,
                Problems = document.Problems,
            });
        }

        return new GetLocalToolsResponse { Manifests = manifests };
    }

    /// <summary>
    /// Pins one tool at a new version. Deliberately does not spawn <c>dotnet</c>: the host
    /// restores afterwards and reports both facts (manifest updated, restore outcome).
    /// </summary>
    private static async Task<object?> HandleUpdateLocalToolAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var manifestPath = ReadRequiredString(parameters, "manifestPath");
        var toolId = ReadRequiredString(parameters, "toolId");
        var expectedVersion = ReadRequiredString(parameters, "expectedVersion");
        var version = ReadRequiredString(parameters, "version");
        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");

        var target = ResolveManifestPath(manifestPath, workspaceRoots);

        try
        {
            var result = await LocalToolManifestWriter
                .UpdateVersionAsync(target, toolId, expectedVersion, version, cancellationToken)
                .ConfigureAwait(false);

            return new UpdateLocalToolResponse
            {
                ManifestPath = result.ManifestPath,
                ToolId = result.ToolId,
                PreviousVersion = result.PreviousVersion,
                Version = result.Version,
                Restore = null,
            };
        }
        catch (WorkspaceException exception)
        {
            throw new RpcException(exception.Code, exception.Message);
        }
        catch (ArgumentException exception)
        {
            throw new RpcException(Constants.InvalidParams, exception.Message);
        }
        catch (IOException exception)
        {
            throw new RpcException(
                Constants.InternalError,
                $"The manifest could not be written: {exception.Message}",
                exception);
        }
        catch (UnauthorizedAccessException exception)
        {
            throw new RpcException(
                Constants.InternalError,
                $"The manifest could not be written: {exception.Message}",
                exception);
        }
    }

    /// <summary>
    /// The manifest path, normalised, once it is proven to sit inside a workspace root and to
    /// name a tool manifest. A relative path would be resolved against the sidecar's working
    /// directory, so one is refused instead of guessed.
    /// </summary>
    private static string ResolveManifestPath(string manifestPath, List<string> workspaceRoots)
    {
        if (!Path.IsPathFullyQualified(manifestPath))
        {
            throw new RpcException(
                Constants.InvalidParams,
                $"'manifestPath' must be an absolute path; got '{manifestPath}'.");
        }

        if (workspaceRoots.Count == 0)
        {
            throw new RpcException(
                Constants.InvalidParams,
                "'workspaceRoots' is required so the manifest path can be validated.");
        }

        string full;
        try
        {
            full = Path.GetFullPath(manifestPath);
        }
        catch (ArgumentException)
        {
            throw new RpcException(
                Constants.InvalidParams,
                $"'manifestPath' is not a usable path: {manifestPath}");
        }

        if (!string.Equals(
            Path.GetFileName(full),
            LocalToolManifestLocator.ManifestFileName,
            StringComparison.OrdinalIgnoreCase))
        {
            throw new RpcException(
                Constants.InvalidParams,
                $"'manifestPath' must name a {LocalToolManifestLocator.ManifestFileName} file; got '{manifestPath}'.");
        }

        foreach (var root in workspaceRoots)
        {
            if (string.IsNullOrWhiteSpace(root))
            {
                continue;
            }

            string fullRoot;
            try
            {
                fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            }
            catch (ArgumentException)
            {
                continue;
            }

            if (IsSameOrInside(full, fullRoot))
            {
                return full;
            }
        }

        throw new RpcException(
            Constants.InvalidParams,
            $"{full} is outside the workspace roots; a manifest is only edited inside the workspace.");
    }

    private static bool IsSameOrInside(string path, string root) =>
        string.Equals(path, root, PathComparison)
        || path.StartsWith(
            Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar,
            PathComparison);

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    private static List<SourceDescriptor> ReadSources(JsonElement parameters)
    {
        var descriptors = new List<SourceDescriptor>();

        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("sources", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return descriptors;
        }

        foreach (var element in array.EnumerateArray())
        {
            var url = ReadOptionalString(element, "url");
            if (string.IsNullOrWhiteSpace(url))
            {
                continue;
            }

            descriptors.Add(new SourceDescriptor
            {
                Url = url,
                Username = ReadOptionalString(element, "username"),
                Password = ReadOptionalString(element, "password"),
                Proxy = ReadOptionalString(element, "proxy"),
            });
        }

        return descriptors;
    }

    private static List<string> ReadStringArray(JsonElement parameters, string property)
    {
        var values = new List<string>();

        if (parameters.ValueKind == JsonValueKind.Object
            && parameters.TryGetProperty(property, out var array)
            && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in array.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String && element.GetString() is { Length: > 0 } value)
                {
                    values.Add(value);
                }
            }
        }

        return values;
    }

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException(Constants.InvalidParams, $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool ReadBoolean(JsonElement element, string property, bool fallback = false)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(property, out var value))
        {
            return value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : fallback;
        }

        return fallback;
    }

    /// <summary>
    /// The first source that can answer supplies the version list; an unreachable feed is
    /// skipped rather than failing the whole tool list, exactly as the dependency closure does.
    /// </summary>
    private sealed class NuGetVersionSource(INuGetSourceProvider sources, IReadOnlyList<SourceDescriptor> descriptors)
        : ILocalToolVersionSource
    {
        public async Task<IReadOnlyList<string>> GetVersionsAsync(
            string packageId,
            bool prerelease,
            CancellationToken cancellationToken)
        {
            foreach (var descriptor in descriptors)
            {
                try
                {
                    var package = await sources
                        .GetSource(descriptor)
                        .GetPackageAsync(packageId, prerelease, cancellationToken)
                        .ConfigureAwait(false);

                    return [.. package.Versions.Select(version => version.Version)];
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception)
                {
                    // Try the next source: no answer from one feed is "latest version unknown",
                    // not a failed tool list.
                }
            }

            return [];
        }
    }
}

/// <summary>One local tool as the webview consumes it (<c>LocalTool</c>).</summary>
public sealed record LocalToolInfo
{
    [JsonPropertyName("Id")]
    public required string Id { get; init; }

    [JsonPropertyName("Commands")]
    public required IReadOnlyList<string> Commands { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    /// <summary><c>rollForward: false</c> in the manifest — a deliberate pin.</summary>
    [JsonPropertyName("Pinned")]
    public required bool Pinned { get; init; }

    /// <summary>Null when no source could answer, or when there is nothing newer.</summary>
    [JsonPropertyName("LatestVersion")]
    public string? LatestVersion { get; init; }

    [JsonPropertyName("UpdateAvailable")]
    public required bool UpdateAvailable { get; init; }

    /// <summary>Filled by the host from its restore probe; the core never guesses it.</summary>
    [JsonPropertyName("NotRestored")]
    public required bool NotRestored { get; init; }
}

/// <summary>One manifest and its tools (<c>LocalToolManifest</c>).</summary>
public sealed record LocalToolManifestInfo
{
    [JsonPropertyName("Path")]
    public required string Path { get; init; }

    [JsonPropertyName("IsRoot")]
    public required bool IsRoot { get; init; }

    [JsonPropertyName("Tools")]
    public required IReadOnlyList<LocalToolInfo> Tools { get; init; }

    /// <summary>Parse errors, duplicate ids or duplicate commands.</summary>
    [JsonPropertyName("Problems")]
    public required IReadOnlyList<string> Problems { get; init; }
}

/// <summary>The answer to <c>readLocalTools</c> (<c>GetLocalToolsResponse</c>).</summary>
public sealed record GetLocalToolsResponse
{
    [JsonPropertyName("Manifests")]
    public required IReadOnlyList<LocalToolManifestInfo> Manifests { get; init; }
}

/// <summary>
/// The outcome of the host's <c>dotnet tool restore</c> after a write
/// (<c>UpdateLocalToolResponse.Restore</c>); the core always answers null because it never restores.
/// </summary>
public sealed record LocalToolRestoreInfo
{
    [JsonPropertyName("Ok")]
    public required bool Ok { get; init; }

    [JsonPropertyName("TimedOut")]
    public required bool TimedOut { get; init; }

    [JsonPropertyName("Message")]
    public string? Message { get; init; }
}

/// <summary>The answer to <c>updateLocalTool</c> (<c>UpdateLocalToolResponse</c>).</summary>
public sealed record UpdateLocalToolResponse
{
    [JsonPropertyName("ManifestPath")]
    public required string ManifestPath { get; init; }

    [JsonPropertyName("ToolId")]
    public required string ToolId { get; init; }

    [JsonPropertyName("PreviousVersion")]
    public required string PreviousVersion { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    /// <summary>Null until the host has run <c>dotnet tool restore</c>.</summary>
    [JsonPropertyName("Restore")]
    public LocalToolRestoreInfo? Restore { get; init; }
}
