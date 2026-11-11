using System.Collections.Concurrent;
using NuGet.Common;
using NuGet.Configuration;
using NuGet.Packaging;
using NuGet.Frameworks;
using NuGet.Packaging.Core;
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
///
/// The third resource, <c>DownloadResource</c>, is only used by
/// <see cref="GetPackageFrameworksAsync"/>, which needs the <c>.nupkg</c> itself.
/// </summary>
public sealed class ProtocolNuGetSource : INuGetSource, IDisposable
{
    private const string PackageNotFoundCode = "packageNotFound";

    private static readonly TimeSpan packageCacheTtl = TimeSpan.FromMinutes(5);

    private readonly string sourceUrl;
    private readonly Func<CancellationToken, Task<PackageSearchResource?>> searchResource;
    private readonly Func<CancellationToken, Task<PackageMetadataResource?>> metadataResource;
    private readonly Func<CancellationToken, Task<DownloadResource?>> downloadResource;
    private readonly ConcurrentDictionary<string, (Package Package, DateTimeOffset StoredAt)> packageCache =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (PackageFrameworks Frameworks, DateTimeOffset StoredAt)> frameworksCache =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (Dictionary<string, IReadOnlyList<NuGetFramework>> Declared, DateTimeOffset StoredAt)> compatibilityCache =
        new(StringComparer.Ordinal);
    private readonly object cacheLock = new();
    private SourceCacheContext cache = new();

    public ProtocolNuGetSource(SourceDescriptor source)
        : this(SourceRepositoryFactory.Create(source))
    {
    }

    /// <summary>Production wiring: resolve the resources from the repository, once.</summary>
    internal ProtocolNuGetSource(SourceRepository repository)
        : this(
            repository.PackageSource.Source,
            repository.GetResourceAsync<PackageSearchResource>,
            repository.GetResourceAsync<PackageMetadataResource>,
            repository.GetResourceAsync<DownloadResource>)
    {
    }

    /// <summary>Test seam: the resources are the only collaborators, so they are the injection point.</summary>
    internal ProtocolNuGetSource(
        string sourceUrl,
        Func<CancellationToken, Task<PackageSearchResource?>> searchResource,
        Func<CancellationToken, Task<PackageMetadataResource?>> metadataResource,
        Func<CancellationToken, Task<DownloadResource?>> downloadResource)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceUrl);
        ArgumentNullException.ThrowIfNull(searchResource);
        ArgumentNullException.ThrowIfNull(metadataResource);
        ArgumentNullException.ThrowIfNull(downloadResource);

        this.sourceUrl = sourceUrl;
        this.searchResource = searchResource;
        this.metadataResource = metadataResource;
        this.downloadResource = downloadResource;
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
            // Search metadata already carries the version list — with per-version download counts,
            // which registration never publishes — so this stays a single request.
            var versions = await metadata.GetVersionsAsync().ConfigureAwait(false);
            packages.Add(PackageMetadataMapper.ToPackage(
                metadata,
                [.. versions.Select(version => new PackageVersionRef(
                    version.Version.ToNormalizedString(),
                    version.DownloadCount))],
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
            .GetMetadataAsync(id, includePrerelease: true, includeUnlisted: false, CurrentCache(), NullLogger.Instance, cancellationToken)
            .ConfigureAwait(false);

        var eligible = PackageMetadataMapper.Eligible(all, prerelease);
        if (eligible.Count == 0)
        {
            throw new NuGetSourceException(PackageNotFoundCode, $"Package {id} was not found on {sourceUrl}.");
        }

        var latest = eligible[^1];
        var popularity = await FindPopularityAsync(id, cancellationToken).ConfigureAwait(false);
        var versionDownloads = await VersionDownloadsAsync(popularity).ConfigureAwait(false);

        var versions = eligible
            .Select(entry => entry.Identity.Version)
            .Select(version => new PackageVersionRef(
                version.ToNormalizedString(),
                versionDownloads is not null
                    && versionDownloads.TryGetValue(version.ToNormalizedString(), out var downloads)
                        ? downloads
                        : null))
            .ToList();

        var package = PackageMetadataMapper.ToPackage(
            latest,
            versions,
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
            ? throw new NuGetSourceException(PackageNotFoundCode, $"Version {version} of {id} was not found on {sourceUrl}.")
            : PackageMetadataMapper.ToDetails(match);
    }

    /// <summary>
    /// Supported frameworks for one version: the package is downloaded, its asset folders are
    /// read, and the declared frameworks are expanded into everything that can consume them.
    ///
    /// This is the one operation that needs the <c>.nupkg</c> itself; the host only calls it when
    /// the frameworks tab is opened, and the answer is cached per id + version.
    /// </summary>
    public async Task<PackageFrameworks> GetPackageFrameworksAsync(
        string id,
        string version,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);

        var key = $"{id.ToLowerInvariant()}|{version.ToLowerInvariant()}";
        if (frameworksCache.TryGetValue(key, out var cached)
            && DateTimeOffset.UtcNow - cached.StoredAt < packageCacheTtl)
        {
            return cached.Frameworks;
        }

        var download = await RequireAsync(downloadResource, nameof(DownloadResource), cancellationToken)
            .ConfigureAwait(false);

        if (!NuGetVersion.TryParse(version, out var parsedVersion))
        {
            throw new NuGetSourceException(
                PackageNotFoundCode,
                $"Version {version} of {id} is not a valid NuGet version.");
        }

        var identity = new PackageIdentity(id, parsedVersion);
        using var result = await download
            .GetDownloadResourceResultAsync(
                identity,
                new PackageDownloadContext(CurrentCache()),
                globalPackagesFolder: ResolveGlobalPackagesFolder(),
                NullLogger.Instance,
                cancellationToken)
            .ConfigureAwait(false);

        if (result.PackageReader is null)
        {
            throw new NuGetSourceException(
                PackageNotFoundCode,
                $"Version {version} of {id} could not be downloaded from {sourceUrl}.");
        }

        var assets = await ReadAssetsAsync(result.PackageReader, cancellationToken).ConfigureAwait(false);
        var frameworks = PackageFrameworksBuilder.Build(
            assets.DeclaredFrameworks,
            assets.Files,
            assets.IsToolPackage);

        frameworksCache[key] = (frameworks, DateTimeOffset.UtcNow);
        return frameworks;
    }

    /// <summary>
    /// Whether each requested version can be consumed by the project frameworks, derived only
    /// from the registration metadata's dependency groups — no <c>.nupkg</c> is downloaded.
    ///
    /// The declared frameworks are cached per id (<c>packageCacheTtl</c>) so two rows of the same
    /// package share one metadata call. Versions the feed does not list are omitted; an
    /// unprovable answer is reported as <c>Known:false, Compatible:true</c> (fail open).
    /// </summary>
    public async Task<IReadOnlyList<PackageVersionCompatibility>> GetVersionCompatibilityAsync(
        string id,
        IReadOnlyList<string> projectFrameworks,
        IReadOnlyList<string>? versions,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(id);
        ArgumentNullException.ThrowIfNull(projectFrameworks);

        var declared = await GetDeclaredFrameworksAsync(id, cancellationToken).ConfigureAwait(false);
        var parsed = PackageFrameworkCompatibility.ParseProjectFrameworks(projectFrameworks);

        var requested = versions is { Count: > 0 } ? versions : [.. declared.Keys];

        var results = new List<PackageVersionCompatibility>(requested.Count);
        foreach (var version in requested)
        {
            // A version the feed does not list has no framework data; the host treats the
            // missing entry as unknown/allowed, so it is simply omitted here.
            if (!declared.TryGetValue(version, out var declaredFrameworks))
            {
                continue;
            }

            results.Add(PackageFrameworkCompatibility.Evaluate(version, declaredFrameworks, parsed));
        }

        return results;
    }

    /// <summary>
    /// Maps each listed version of the package to the target frameworks its dependency groups
    /// declare, caching the answer per id. A version with no dependency groups maps to an empty
    /// list, which <see cref="PackageFrameworkCompatibility.Evaluate"/> reads as unknown.
    /// </summary>
    private async Task<Dictionary<string, IReadOnlyList<NuGetFramework>>> GetDeclaredFrameworksAsync(
        string id,
        CancellationToken cancellationToken)
    {
        var key = id.ToLowerInvariant();
        if (compatibilityCache.TryGetValue(key, out var cached)
            && DateTimeOffset.UtcNow - cached.StoredAt < packageCacheTtl)
        {
            return cached.Declared;
        }

        var metadata = await RequireAsync(metadataResource, nameof(PackageMetadataResource), cancellationToken)
            .ConfigureAwait(false);

        var all = await metadata
            .GetMetadataAsync(id, includePrerelease: true, includeUnlisted: false, CurrentCache(), NullLogger.Instance, cancellationToken)
            .ConfigureAwait(false);

        var declared = new Dictionary<string, IReadOnlyList<NuGetFramework>>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in all)
        {
            var frameworks = entry.DependencySets?
                .Select(set => set.TargetFramework)
                .Where(framework => framework is not null)
                .ToList() ?? [];
            declared[entry.Identity.Version.ToNormalizedString()] = frameworks;
        }

        compatibilityCache[key] = (declared, DateTimeOffset.UtcNow);
        return declared;
    }

    public void ClearPackageCache(string? packageId = null)
    {
        if (packageId is null)
        {
            packageCache.Clear();
            frameworksCache.Clear();
            compatibilityCache.Clear();
        }
        else
        {
            var prefix = packageId.ToLowerInvariant() + "|";

            foreach (var key in packageCache.Keys.Where(key =>
                key.StartsWith(prefix, StringComparison.Ordinal)))
            {
                packageCache.TryRemove(key, out _);
            }

            foreach (var key in frameworksCache.Keys.Where(key =>
                key.StartsWith(prefix, StringComparison.Ordinal)))
            {
                frameworksCache.TryRemove(key, out _);
            }

            compatibilityCache.TryRemove(packageId.ToLowerInvariant(), out _);
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

    /// <summary>
    /// Per-version download counts from the search hit, keyed by normalized version. Registration
    /// publishes none of them, so a feed without search support leaves every count unknown;
    /// versions the search resource does not mention keep <c>null</c> rather than a wrong zero.
    /// </summary>
    private static async Task<Dictionary<string, long?>?> VersionDownloadsAsync(
        IPackageSearchMetadata? popularity)
    {
        if (popularity is null)
        {
            return null;
        }

        try
        {
            var versions = await popularity.GetVersionsAsync().ConfigureAwait(false);
            var counts = new Dictionary<string, long?>(StringComparer.OrdinalIgnoreCase);

            foreach (var version in versions)
            {
                counts[version.Version.ToNormalizedString()] = version.DownloadCount;
            }

            return counts;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return null;
        }
    }

    /// <summary>
    /// What the framework expansion needs from an opened package: the frameworks its typed item
    /// groups declare, its file list (for the folders with no typed accessor), and whether it is
    /// a dotnet tool.
    /// </summary>
    private static async Task<(List<string> DeclaredFrameworks, List<string> Files, bool IsToolPackage)>
        ReadAssetsAsync(PackageReaderBase reader, CancellationToken cancellationToken)
    {
        var declared = new List<string>();

        AddFrameworks(declared, await reader.GetLibItemsAsync(cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetReferenceItemsAsync(cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetBuildItemsAsync(cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetContentItemsAsync(cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetItemsAsync("buildTransitive", cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetItemsAsync("ref", cancellationToken).ConfigureAwait(false));
        AddFrameworks(declared, await reader.GetItemsAsync("runtimes", cancellationToken).ConfigureAwait(false));

        // A non-empty tools group is what makes a package a tool; its assets are then the
        // frameworks the tool declares.
        var toolItems = await reader.GetToolItemsAsync(cancellationToken).ConfigureAwait(false);
        AddFrameworks(declared, toolItems);

        var isToolPackage = toolItems.Any();
        if (!isToolPackage)
        {
            var types = await reader.GetPackageTypesAsync(cancellationToken).ConfigureAwait(false);
            isToolPackage = types.Any(type =>
                string.Equals(type.Name, "DotnetTool", StringComparison.OrdinalIgnoreCase));
        }

        var files = await reader.GetFilesAsync(cancellationToken).ConfigureAwait(false);

        return ([.. declared], [.. files], isToolPackage);
    }

    private static void AddFrameworks(List<string> declared, IEnumerable<FrameworkSpecificGroup> groups)
    {
        // Folder groups such as runtimes/ are keyed by RID, not a TFM; only a real
        // framework belongs in the declaration list.
        declared.AddRange(groups
            .Where(group => group.TargetFramework.IsSpecificFramework)
            .Select(group => group.TargetFramework.GetShortFolderName()));
    }

    /// <summary>
    /// NuGet's download resource requires a non-null global packages folder even when the caller
    /// only needs the package reader. Use the folder NuGet resolves so an already-restored package
    /// is served from the local cache, with the environment/user default as a fallback.
    /// </summary>
    private static string ResolveGlobalPackagesFolder()
    {
        try
        {
            var folder = SettingsUtility.GetGlobalPackagesFolder(Settings.LoadDefaultSettings(root: null));
            if (!string.IsNullOrWhiteSpace(folder))
            {
                return folder;
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Fall through to the environment/user default.
        }

        var fromEnvironment = Environment.GetEnvironmentVariable("NUGET_PACKAGES");
        return !string.IsNullOrWhiteSpace(fromEnvironment)
            ? fromEnvironment
            : Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".nuget",
                "packages");
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
