using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// NuGet v3 source over HTTP, mirroring the TypeScript client's behaviour: the service index
/// is resolved once per instance, and credentials are attached only for the configured source
/// host and the hosts its own service index declares — never for a URL a feed hands back.
/// </summary>
public sealed class HttpNuGetSource : INuGetSource, IDisposable
{
    private readonly SourceDescriptor source;
    private readonly NuGetHttpClient http;
    private readonly HashSet<string> trustedHosts;
    private string? searchUrl;
    private string? registrationsBaseUrl;
    private bool indexResolved;
    private AuthenticationHeaderValue? authorization;

    /// <summary>The TypeScript client's 5-minute package cache; the host calls this per row.</summary>
    private static readonly TimeSpan packageCacheTtl = TimeSpan.FromMinutes(5);
    private readonly ConcurrentDictionary<string, (Package Package, DateTimeOffset StoredAt)> packageCache =
        new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PackageDetails> detailsCache = new(StringComparer.Ordinal);

    public HttpNuGetSource(SourceDescriptor source, HttpMessageHandler? handler = null)
    {
        ArgumentNullException.ThrowIfNull(source);

        this.source = source;
        http = new NuGetHttpClient(source.Proxy, handler);
        // Uri.Host is already lower-cased, so an ordinal set is enough.
        trustedHosts = [];

        if (Uri.TryCreate(source.Url, UriKind.Absolute, out var uri))
        {
            trustedHosts.Add(uri.Host);
        }
    }

    public async Task<IReadOnlyList<Package>> SearchAsync(
        string filter,
        bool prerelease,
        int skip,
        int take,
        CancellationToken cancellationToken)
    {
        await EnsureServiceIndexAsync(cancellationToken).ConfigureAwait(false);

        if (searchUrl is null)
        {
            throw new NuGetSourceException("sourceUnreachable", "The source publishes no SearchQueryService.");
        }

        var query =
            $"{searchUrl}?q={Uri.EscapeDataString(filter)}&take={take}&skip={skip}"
            + $"&prerelease={prerelease.ToString().ToLowerInvariant()}&semVerLevel=2.0.0";

        using var document = await http
            .GetJsonAsync(query, cancellationToken, AuthorizationFor)
            .ConfigureAwait(false);
        return PackageMapping.MapSearch(document.RootElement);
    }

    public async Task<Package> GetPackageAsync(string id, bool prerelease, CancellationToken cancellationToken)
    {
        await EnsureServiceIndexAsync(cancellationToken).ConfigureAwait(false);

        if (registrationsBaseUrl is null)
        {
            throw new NuGetSourceException("sourceUnreachable", "The source publishes no RegistrationsBaseUrl.");
        }

        var indexUrl = $"{registrationsBaseUrl}{id.ToLowerInvariant()}/index.json";
        var cacheKey = $"{id.ToLowerInvariant()}|{prerelease}";

        if (packageCache.TryGetValue(cacheKey, out var cached)
            && DateTimeOffset.UtcNow - cached.StoredAt < packageCacheTtl)
        {
            return cached.Package;
        }

        var leaves = await ReadRegistrationLeavesAsync(indexUrl, cancellationToken, "packageNotFound")
            .ConfigureAwait(false);

        var package = PackageMapping.MapRegistration(leaves, prerelease) ?? throw new NuGetSourceException(
            "packageNotFound",
            $"Package info couldn't be found for url: {indexUrl}");

        packageCache[cacheKey] = (package, DateTimeOffset.UtcNow);
        return package;
    }

    public void ClearPackageCache(string? packageId = null)
    {
        if (packageId is null)
        {
            packageCache.Clear();
            detailsCache.Clear();
            return;
        }

        var prefix = packageId.ToLowerInvariant() + "|";
        foreach (var key in packageCache.Keys.Where(key => key.StartsWith(prefix, StringComparison.Ordinal)))
        {
            packageCache.TryRemove(key, out _);
        }
    }

    public async Task<PackageDetails> GetPackageDetailsAsync(
        string packageVersionUrl,
        CancellationToken cancellationToken)
    {
        await EnsureServiceIndexAsync(cancellationToken).ConfigureAwait(false);

        if (!IsTrustedSourceUrl(packageVersionUrl))
        {
            throw new NuGetSourceException(
                "untrustedSource",
                "Refusing to fetch package details from an untrusted source host");
        }

        if (detailsCache.TryGetValue(packageVersionUrl, out var cachedDetails))
        {
            return cachedDetails;
        }

        using var leaf = await http
            .GetJsonAsync(packageVersionUrl, cancellationToken, AuthorizationFor)
            .ConfigureAwait(false);

        var details = await ReadDetailsAsync(leaf.RootElement, cancellationToken).ConfigureAwait(false);
        detailsCache[packageVersionUrl] = details;
        return details;
    }

    private async Task<PackageDetails> ReadDetailsAsync(
        System.Text.Json.JsonElement leaf,
        CancellationToken cancellationToken)
    {
        if (!leaf.TryGetProperty("catalogEntry", out var catalogEntry))
        {
            return PackageMapping.MapDependencyGroups(default);
        }

        // Some feeds embed the catalog entry; others hand back a URL that must be fetched.
        if (catalogEntry.ValueKind == JsonValueKind.Object
            && catalogEntry.TryGetProperty("dependencyGroups", out _))
        {
            return PackageMapping.MapDependencyGroups(catalogEntry);
        }

        string? catalogUrl = null;
        if (catalogEntry.ValueKind == JsonValueKind.String)
        {
            catalogUrl = catalogEntry.GetString();
        }
        else if (catalogEntry.ValueKind == JsonValueKind.Object
            && catalogEntry.TryGetProperty("@id", out var id)
            && id.ValueKind == JsonValueKind.String)
        {
            catalogUrl = id.GetString();
        }

        if (string.IsNullOrEmpty(catalogUrl))
        {
            return PackageMapping.MapDependencyGroups(default);
        }

        using var catalog = await http
            .GetJsonAsync(catalogUrl, cancellationToken, AuthorizationFor)
            .ConfigureAwait(false);
        return PackageMapping.MapDependencyGroups(catalog.RootElement);
    }

    public void Dispose() => http.Dispose();

    /// <summary>Reads the registration leaves, following pages that are not embedded.</summary>
    private async Task<List<JsonElement>> ReadRegistrationLeavesAsync(
        string indexUrl,
        CancellationToken cancellationToken,
        string notFoundCode = "sourceUnreachable")
    {
        var leaves = new List<JsonElement>();

        using var index = await http
            .GetJsonAsync(indexUrl, cancellationToken, AuthorizationFor, notFoundCode)
            .ConfigureAwait(false);

        if (!index.RootElement.TryGetProperty("items", out var pages) || pages.ValueKind != JsonValueKind.Array)
        {
            return leaves;
        }

        foreach (var page in pages.EnumerateArray())
        {
            leaves.AddRange(await ReadPageLeavesAsync(page, cancellationToken).ConfigureAwait(false));
        }

        return leaves;
    }

    /// <summary>The leaves a single registration page carries, embedded or by reference.</summary>
    private async Task<List<JsonElement>> ReadPageLeavesAsync(
        JsonElement page,
        CancellationToken cancellationToken)
    {
        if (page.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
        {
            return [.. items.EnumerateArray().Select(item => item.Clone())];
        }

        // A page can be a reference to fetch on its own.
        var pageUrl = TrustedPageUrl(page);
        if (pageUrl is null)
        {
            return [];
        }

        using var pageDocument = await http
            .GetJsonAsync(pageUrl, cancellationToken, AuthorizationFor)
            .ConfigureAwait(false);

        return pageDocument.RootElement.TryGetProperty("items", out var pageItems)
            && pageItems.ValueKind == JsonValueKind.Array
                ? [.. pageItems.EnumerateArray().Select(item => item.Clone())]
                : [];
    }

    /// <summary>Absolute URL of a page that has to be fetched separately, when it is trusted.</summary>
    private string? TrustedPageUrl(JsonElement page)
    {
        if (!page.TryGetProperty("@id", out var pageId) || pageId.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        var pageUrl = pageId.GetString();
        return string.IsNullOrEmpty(pageUrl) || !IsTrustedSourceUrl(pageUrl) ? null : pageUrl;
    }

    private async Task EnsureServiceIndexAsync(CancellationToken cancellationToken)
    {
        if (indexResolved)
        {
            return;
        }

        using var index = await http.GetJsonAsync(source.Url, cancellationToken).ConfigureAwait(false);

        if (index.RootElement.TryGetProperty("resources", out var resources)
            && resources.ValueKind == JsonValueKind.Array)
        {
            searchUrl = FindResource(resources, "SearchQueryService", highestVersion: false);
            registrationsBaseUrl = FindResource(resources, "RegistrationsBaseUrl", highestVersion: true);

            foreach (var resource in new[] { searchUrl, registrationsBaseUrl })
            {
                if (!string.IsNullOrEmpty(resource)
                    && Uri.TryCreate(resource, UriKind.Absolute, out var uri))
                {
                    trustedHosts.Add(uri.Host);
                }
            }
        }

        searchUrl = EnsureTrailingSlash(searchUrl);
        registrationsBaseUrl = EnsureTrailingSlash(registrationsBaseUrl);
        indexResolved = true;
    }

    private static string? FindResource(JsonElement resources, string type, bool highestVersion)
    {
        var matches = resources.EnumerateArray()
            .Where(resource =>
                resource.TryGetProperty("@type", out var resourceType)
                && resourceType.ValueKind == JsonValueKind.String
                && (resourceType.GetString() ?? string.Empty).StartsWith(type, StringComparison.Ordinal))
            .ToList();

        if (matches.Count == 0)
        {
            return null;
        }

        if (highestVersion)
        {
            // The TypeScript client picks the highest versioned resource, e.g.
            // RegistrationsBaseUrl/3.6.0 over RegistrationsBaseUrl/3.4.0.
            matches.Sort((left, right) => string.CompareOrdinal(
                right.GetProperty("@type").GetString(),
                left.GetProperty("@type").GetString()));
        }

        return matches[0].TryGetProperty("@id", out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString()
            : null;
    }

    private static string? EnsureTrailingSlash(string? url) =>
        string.IsNullOrEmpty(url) || url.EndsWith('/') ? url : url + "/";

    private bool IsTrustedSourceUrl(string url)
    {
        if (trustedHosts.Count == 0)
        {
            return false;
        }

        return Uri.TryCreate(url, UriKind.RelativeOrAbsolute, out var parsed)
            && trustedHosts.Contains(parsed.IsAbsoluteUri
                ? parsed.Host
                : new Uri(new Uri(source.Url), parsed).Host);
    }

    /// <summary>Basic auth, scoped to the trusted hosts only.</summary>
    private AuthenticationHeaderValue? AuthorizationFor(Uri uri)
    {
        if (string.IsNullOrEmpty(source.Password) || !trustedHosts.Contains(uri.Host))
        {
            return null;
        }

        authorization ??= new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes($"{source.Username ?? string.Empty}:{source.Password}")));

        return authorization;
    }
}
