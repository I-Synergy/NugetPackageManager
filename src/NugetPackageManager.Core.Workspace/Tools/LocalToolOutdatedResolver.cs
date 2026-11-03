using NuGet.Versioning;

namespace NugetPackageManager.Core.Workspace.Tools;

/// <summary>
/// Where the latest eligible version of a package comes from: the package source the host
/// resolved for this document. Kept as a delegate-shaped seam so the workspace project stays
/// independent of <c>Core.NuGet</c>.
/// </summary>
public interface ILocalToolVersionSource
{
    /// <summary>
    /// The versions the source offers for <paramref name="packageId"/>, in any order; an empty
    /// list (never an exception) when the source has no answer, so one unreachable feed cannot
    /// fail the whole tool list.
    /// </summary>
    /// <param name="packageId">The tool's package id.</param>
    /// <param name="prerelease">Whether prerelease versions may be considered.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    Task<IReadOnlyList<string>> GetVersionsAsync(
        string packageId,
        bool prerelease,
        CancellationToken cancellationToken);
}

/// <summary>The latest version a tool could move to, and whether that is an update.</summary>
public sealed record LocalToolOutdatedResult
{
    /// <summary>
    /// The highest version strictly greater than the current one, or <c>null</c> when there is
    /// none — a manifest is never offered a downgrade or the version it already pins.
    /// </summary>
    public string? LatestVersion { get; init; }

    /// <summary>True when <see cref="LatestVersion"/> is an upgrade the user may apply.</summary>
    public bool UpdateAvailable { get; init; }
}

/// <summary>
/// Chooses the latest eligible version for each tool in a manifest.
///
/// The rules are the guardrails: prerelease versions only when the caller opted in, never a
/// downgrade and never the version already pinned. Lookups are cached per id + prerelease flag
/// for the life of the instance, which is one document generation — a manifest that declares the
/// same tool twice, or two manifests that share a tool, cost one lookup.
/// </summary>
public sealed class LocalToolOutdatedResolver
{
    private readonly ILocalToolVersionSource source;
    private readonly bool allowPrerelease;
    private readonly Dictionary<(string Id, bool Prerelease), IReadOnlyList<string>> cache = [];

    /// <summary>Creates a resolver over one version source.</summary>
    /// <param name="source">The package source lookup.</param>
    /// <param name="allowPrerelease">Whether prerelease versions are eligible at all.</param>
    public LocalToolOutdatedResolver(ILocalToolVersionSource source, bool allowPrerelease = false)
    {
        ArgumentNullException.ThrowIfNull(source);

        this.source = source;
        this.allowPrerelease = allowPrerelease;
    }

    /// <summary>Whether this resolver may offer prerelease versions.</summary>
    public bool AllowPrerelease => allowPrerelease;

    /// <summary>How many distinct lookups this instance has performed or cached.</summary>
    public int CachedLookups => cache.Count;

    /// <summary>
    /// The latest eligible version for <paramref name="packageId"/>, given the version the
    /// manifest pins.
    /// </summary>
    /// <param name="packageId">The tool's package id.</param>
    /// <param name="currentVersion">The version the manifest pins.</param>
    /// <param name="cancellationToken">Cancels the lookup.</param>
    public async Task<LocalToolOutdatedResult> ResolveAsync(
        string packageId,
        string currentVersion,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageId);
        ArgumentException.ThrowIfNullOrWhiteSpace(currentVersion);

        var versions = await GetVersionsAsync(packageId, cancellationToken).ConfigureAwait(false);
        var current = Parse(currentVersion);
        if (current is null)
        {
            return new LocalToolOutdatedResult();
        }

        (NuGetVersion Parsed, string Text)? best = null;

        foreach (var text in versions)
        {
            var parsed = Parse(text);
            if (parsed is null || (parsed.IsPrerelease && !allowPrerelease))
            {
                continue;
            }

            if (best is null || parsed > best.Value.Parsed)
            {
                best = (parsed, text);
            }
        }

        // A downgrade or the pinned version itself is never an update.
        return best is null || best.Value.Parsed <= current
            ? new LocalToolOutdatedResult { LatestVersion = null, UpdateAvailable = false }
            : new LocalToolOutdatedResult { LatestVersion = best.Value.Text, UpdateAvailable = true };
    }

    /// <summary>Forgets every cached lookup, for a forced refresh.</summary>
    public void Clear() => cache.Clear();

    /// <summary>Forgets the cached lookups for one package id.</summary>
    /// <param name="packageId">The package id to forget.</param>
    public void Clear(string packageId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packageId);

        foreach (var key in cache.Keys.Where(key =>
            string.Equals(key.Id, packageId, StringComparison.OrdinalIgnoreCase)).ToList())
        {
            cache.Remove(key);
        }
    }

    private async Task<IReadOnlyList<string>> GetVersionsAsync(
        string packageId,
        CancellationToken cancellationToken)
    {
        var key = (packageId, allowPrerelease);
        if (cache.TryGetValue(key, out var cached))
        {
            return cached;
        }

        var versions = await source.GetVersionsAsync(packageId, allowPrerelease, cancellationToken)
            .ConfigureAwait(false);

        cache[key] = versions;
        return versions;
    }

    private static NuGetVersion? Parse(string version) =>
        NuGetVersion.TryParse(version, out var parsed) ? parsed : null;
}
