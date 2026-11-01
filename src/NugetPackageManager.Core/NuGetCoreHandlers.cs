using System.Text.Json;
using NugetPackageManager.Core.NuGet;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.NuGet.Vulnerabilities;
using NugetPackageManager.Core.Protocol;

namespace NugetPackageManager.Core;

/// <summary>
/// The NuGet methods the sidecar exposes over NDJSON. Each one is a user-level operation —
/// the host never crosses the process boundary for a helper call.
/// </summary>
public sealed class NuGetCoreHandlers
{
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
            throw new RpcException(RpcException.InvalidParams, "'id' is required.");
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
        var packageVersionUrl = ReadString(parameters, "packageVersionUrl");
        if (string.IsNullOrWhiteSpace(packageVersionUrl))
        {
            throw new RpcException(RpcException.InvalidParams, "'packageVersionUrl' is required.");
        }

        return await GuardAsync(() => sources
            .GetSource(source)
            .GetPackageDetailsAsync(packageVersionUrl, cancellationToken)).ConfigureAwait(false);
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
            throw new RpcException(RpcException.InvalidParams, "A 'source' object is required.");
        }

        var url = ReadString(source, "url");
        if (string.IsNullOrWhiteSpace(url))
        {
            throw new RpcException(RpcException.InvalidParams, "source.url is required.");
        }

        return new SourceDescriptor
        {
            Url = url,
            Username = ReadString(source, "username"),
            Password = ReadString(source, "password"),
            Proxy = ReadString(source, "proxy"),
        };
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
