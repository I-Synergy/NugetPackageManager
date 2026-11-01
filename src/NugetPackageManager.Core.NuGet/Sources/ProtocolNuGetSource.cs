using System.Collections.Concurrent;
using NuGet.Common;
using NuGet.Protocol.Core.Types;
using NuGet.Versioning;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// One NuGet v3 source through the official <c>NuGet.Protocol</c> resources.
///
/// Two resources answer different questions, and the split is part of the protocol:
/// <c>PackageMetadataResource</c> (registration) is authoritative for versions and dependency
/// groups but publishes no popularity data, while <c>PackageSearchResource</c> carries the
/// download count and verified-owner flag. <see cref="GetPackageAsync"/> therefore enriches the
/// registration answer with one best-effort search lookup — and leaves the fields null when the
/// feed cannot answer, which is what makes "unknown" visible instead of silently zero.
/// </summary>
public sealed class ProtocolNuGetSource : INuGetSource, IDisposable
{
    private static readonly TimeSpan packageCacheTtl = TimeSpan.FromMinutes(5);

    private readonly string sourceUrl;
    private readonly Func<CancellationToken, Task<PackageSearchResource?>> searchResource;
    private readonly Func<CancellationToken, Task<PackageMetadataResource?>> metadataResource;
    private readonly ConcurrentDictionary<string, (Package Package, DateTimeOffset StoredAt)> packageCache =
        new(StringComparer.Ordinal);
    private readonly object cacheLock = new();
    private SourceCacheContext cache = new();

    public ProtocolNuGetSource(SourceDescriptor source)
        : this(SourceRepositoryFactory.Create(source))
    {
    }

    /// <summary>Production wiring: resolve both resources from the repository, once.</summary>
    internal ProtocolNuGetSource(SourceRepository repository)
        : this(
            repository.PackageSource.Source,
            repository.GetResourceAsync<PackageSearchResource>,
            repository.GetResourceAsync<PackageMetadataResource>)
    {
    }

    /// <summary>Test seam: the resources are the only collaborator, so they are the injection point.</summary>
    internal ProtocolNuGetSource(
        string sourceUrl,
        Func<CancellationToken, Task<PackageSearchResource?>> searchResource,
        Func<CancellationToken, Task<PackageMetadataResource?>> metadataResource)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceUrl);
        ArgumentNullException.ThrowIfNull(searchResource);
        ArgumentNullException.ThrowIfNull(metadataResource);

        this.sourceUrl = sourceUrl;
        this.searchResource = searchResource;
        this.metadataResource = metadataResource;
    }

    public async Task<IReadOnlyList<Package>> SearchAsync(
        string filter,
        bool prerelease,
        int skip,
        int take,
        CancellationToken cancellationToken)
    {
        var search = await RequireAsync(searchResource, nameof(PackageSearchResource), cancellationToken)
            .ConfigureAwait(false);

        var results = await search
            .SearchAsync(filter, new SearchFilter(prerelease), skip, take, NullLogger.Instance, cancellationToken)
            .ConfigureAwait(false);

        var packages = new List<Package>();
        foreach (var metadata in results)
        {
            // Search metadata already carries the version list, so this stays a single request.
            var versions = await metadata.GetVersionsAsync().ConfigureAwait(false);
            packages.Add(PackageMetadataMapper.ToPackage(
                metadata,
                [.. versions.Select(version => version.Version)],
                metadata.DownloadCount,
                metadata.PrefixReserved));
        }

        return packages;
    }

    public async Task<Package> GetPackageAsync(string id, bool prerelease, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);

        var key = $"{id.ToLowerInvariant()}|{prerelease}";
        if (packageCache.TryGetValue(key, out var cached)
            && DateTimeOffset.UtcNow - cached.StoredAt < packageCacheTtl)
        {
            return cached.Package;
        }

        var metadata = await RequireAsync(metadataResource, nameof(PackageMetadataResource), cancellationToken)
            .ConfigureAwait(false);

        var all = await metadata
            .GetMetadataAsync(id, prerelease, includeUnlisted: false, CurrentCache(), NullLogger.Instance, cancellationToken)
            .ConfigureAwait(false);

        var eligible = PackageMetadataMapper.Eligible(all, prerelease);
        if (eligible.Count == 0)
        {
            throw new NuGetSourceException("packageNotFound", $"Package {id} was not found on {sourceUrl}.");
        }

        var latest = eligible[^1];
        var popularity = await FindPopularityAsync(id, cancellationToken).ConfigureAwait(false);

        var package = PackageMetadataMapper.ToPackage(
            latest,
            [.. eligible.Select(entry => entry.Identity.Version)],
            popularity?.DownloadCount,
            popularity?.PrefixReserved);

        packageCache[key] = (package, DateTimeOffset.UtcNow);
        return package;
    }

    public async Task<PackageDetails> GetPackageDetailsAsync(
        string id,
        string version,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);

        var metadata = await RequireAsync(metadataResource, nameof(PackageMetadataResource), cancellationToken)
            .ConfigureAwait(false);

        var all = await metadata
            .GetMetadataAsync(id, includePrerelease: true, includeUnlisted: true, CurrentCache(), NullLogger.Instance, cancellationToken)
            .ConfigureAwait(false);

        var wanted = NuGetVersion.TryParse(version, out var parsed) ? parsed : null;
        var match = all.FirstOrDefault(entry => wanted is not null && entry.Identity.Version == wanted)
            ?? all.FirstOrDefault(entry => string.Equals(
                entry.Identity.Version.ToNormalizedString(),
                version,
                StringComparison.OrdinalIgnoreCase));

        return match is null
            ? throw new NuGetSourceException("packageNotFound", $"Version {version} of {id} was not found on {sourceUrl}.")
            : PackageMetadataMapper.ToDetails(match);
    }

    public void ClearPackageCache(string? packageId = null)
    {
        if (packageId is null)
        {
            packageCache.Clear();
        }
        else
        {
            foreach (var key in packageCache.Keys.Where(key =>
                key.StartsWith(packageId.ToLowerInvariant() + "|", StringComparison.Ordinal)))
            {
                packageCache.TryRemove(key, out _);
            }
        }

        // Bypass NuGet.Protocol's own in-memory/HTTP cache for the next call.
        lock (cacheLock)
        {
            cache.Dispose();
            cache = new SourceCacheContext();
        }
    }

    public void Dispose()
    {
        lock (cacheLock)
        {
            cache.Dispose();
        }
    }

    /// <summary>
    /// Download count and verified-owner flag for one id. Best-effort: feeds that publish no
    /// <c>SearchQueryService</c> (or ignore the <c>packageid:</c> convention) leave the values
    /// unknown, which is a truthful answer — never a wrong zero.
    /// </summary>
    private async Task<IPackageSearchMetadata?> FindPopularityAsync(string id, CancellationToken cancellationToken)
    {
        try
        {
            var search = await searchResource(cancellationToken).ConfigureAwait(false);
            if (search is null)
            {
                return null;
            }

            var results = await search
                .SearchAsync($"packageid:{id}", new SearchFilter(includePrerelease: true), 0, 5, NullLogger.Instance, cancellationToken)
                .ConfigureAwait(false);

            return results.FirstOrDefault(metadata =>
                string.Equals(metadata.Identity.Id, id, StringComparison.OrdinalIgnoreCase));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return null;
        }
    }

    private async Task<T> RequireAsync<T>(
        Func<CancellationToken, Task<T?>> resource,
        string name,
        CancellationToken cancellationToken)
        where T : class =>
        await resource(cancellationToken).ConfigureAwait(false)
        ?? throw new NuGetSourceException("sourceUnreachable", $"The source {sourceUrl} does not publish {name}.");

    private SourceCacheContext CurrentCache()
    {
        lock (cacheLock)
        {
            return cache;
        }
    }
}
