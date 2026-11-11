using System.Text.Json;
using NugetPackageManager.Core.NuGet;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.NuGet.Vulnerabilities;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core;

/// <summary>
/// The NuGet methods the sidecar exposes over NDJSON. Each one is a user-level operation —
/// the host never crosses the process boundary for a helper call.
/// </summary>
public sealed class NuGetCoreHandlers
{
    private const string IdRequiredMessage = "'id' is required.";

    private readonly IVulnerabilityReader vulnerabilityReader;
    private readonly INuGetSourceProvider sources;

    public NuGetCoreHandlers(IVulnerabilityReader vulnerabilityReader, INuGetSourceProvider sources)
    {
        ArgumentNullException.ThrowIfNull(vulnerabilityReader);
        ArgumentNullException.ThrowIfNull(sources);

        this.vulnerabilityReader = vulnerabilityReader;
        this.sources = sources;
    }

    public Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["getVulnerabilities"] = HandleGetVulnerabilitiesAsync,
            ["getPackages"] = HandleGetPackagesAsync,
            ["getPackage"] = HandleGetPackageAsync,
            ["getPackageDetails"] = HandleGetPackageDetailsAsync,
            ["getPackageFrameworks"] = HandleGetPackageFrameworksAsync,
            ["getPackageVersionCompatibility"] = HandleGetPackageVersionCompatibilityAsync,
            ["clearPackageCache"] = HandleClearPackageCacheAsync,
            ["clearVulnerabilityCache"] = HandleClearVulnerabilityCacheAsync,
        };

    private async Task<object?> HandleGetPackagesAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var filter = ReadString(parameters, "filter") ?? string.Empty;
        var prerelease = ReadBoolean(parameters, "prerelease");
        var skip = ReadInt32(parameters, "skip");
        var take = ReadInt32(parameters, "take") is var requested and > 0 ? requested : 20;

        return await GuardAsync(() => sources
            .GetSource(source)
            .SearchAsync(filter, prerelease, skip, take, cancellationToken)).ConfigureAwait(false);
    }

    private async Task<object?> HandleGetPackageAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var id = ReadString(parameters, "id");
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new RpcException(Constants.InvalidParams, IdRequiredMessage);
        }

        var prerelease = ReadBoolean(parameters, "prerelease");

        return await GuardAsync(() => sources
            .GetSource(source)
            .GetPackageAsync(id, prerelease, cancellationToken)).ConfigureAwait(false);
    }

    private async Task<object?> HandleGetPackageDetailsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var id = ReadString(parameters, "id");
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new RpcException(Constants.InvalidParams, IdRequiredMessage);
        }

        var version = ReadString(parameters, "version");
        if (string.IsNullOrWhiteSpace(version))
        {
            throw new RpcException(Constants.InvalidParams, "'version' is required.");
        }

        return await GuardAsync(() => sources
            .GetSource(source)
            .GetPackageDetailsAsync(id, version, cancellationToken)).ConfigureAwait(false);
    }

    private async Task<object?> HandleGetPackageFrameworksAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var id = ReadString(parameters, "id");
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new RpcException(Constants.InvalidParams, IdRequiredMessage);
        }

        var version = ReadString(parameters, "version");
        if (string.IsNullOrWhiteSpace(version))
        {
            throw new RpcException(Constants.InvalidParams, "'version' is required.");
        }

        return await GuardAsync(() => sources
            .GetSource(source)
            .GetPackageFrameworksAsync(id, version, cancellationToken)).ConfigureAwait(false);
    }

    private async Task<object?> HandleGetPackageVersionCompatibilityAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var id = ReadString(parameters, "id");
        if (string.IsNullOrWhiteSpace(id))
        {
            throw new RpcException(Constants.InvalidParams, IdRequiredMessage);
        }

        var projectFrameworks = ReadStringArray(parameters, "projectFrameworks") ?? [];
        var versions = ReadStringArray(parameters, "versions");

        return await GuardAsync(() => sources
            .GetSource(source)
            .GetVersionCompatibilityAsync(id, projectFrameworks, versions, cancellationToken)).ConfigureAwait(false);
    }

    private Task<object?> HandleClearPackageCacheAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        // No id clears every cached package, matching the TypeScript factory's ClearCache().
        sources.ClearPackageCaches(ReadString(parameters, "packageId"));
        return Task.FromResult<object?>(new { cleared = true });
    }

    private Task<object?> HandleClearVulnerabilityCacheAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = parameters;
        _ = cancellationToken;

        vulnerabilityReader.ClearVulnerabilityCache();
        return Task.FromResult<object?>(new { cleared = true });
    }

    private async Task<object?> HandleGetVulnerabilitiesAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var source = ReadSource(parameters);
        var entries = await GuardAsync(() => vulnerabilityReader.ReadAsync(source, cancellationToken))
            .ConfigureAwait(false);

        return new { entries };
    }

    /// <summary>
    /// Source failures carry a stable code the adapter maps to a user-facing message; without
    /// this they would reach the transport as an anonymous internal error.
    /// </summary>
    private static async Task<T> GuardAsync<T>(Func<Task<T>> action)
    {
        try
        {
            return await action().ConfigureAwait(false);
        }
        catch (NuGetSourceException ex)
        {
            throw new RpcException(ex.Code, ex.Message);
        }
    }

    private static SourceDescriptor ReadSource(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("source", out var source)
            || source.ValueKind != JsonValueKind.Object)
        {
            throw new RpcException(Constants.InvalidParams, "A 'source' object is required.");
        }

        var url = ReadString(source, "url");
        if (string.IsNullOrWhiteSpace(url))
        {
            throw new RpcException(Constants.InvalidParams, "source.url is required.");
        }

        return new SourceDescriptor
        {
            Url = url,
            Username = ReadString(source, "username"),
            Password = ReadString(source, "password"),
            Proxy = ReadString(source, "proxy"),
        };
    }

    private static List<string>? ReadStringArray(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var items = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String && item.GetString() is { } text)
            {
                items.Add(text);
            }
        }

        return items;
    }

    private static string? ReadString(JsonElement element, string property) =>
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
