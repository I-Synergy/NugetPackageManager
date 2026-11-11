using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>The three metadata operations the host needs from one package source.</summary>
public interface INuGetSource
{
    Task<IReadOnlyList<Package>> SearchAsync(
        string filter,
        bool prerelease,
        int skip,
        int take,
        CancellationToken cancellationToken);

    /// <summary>Throws <see cref="NuGetSourceException"/> with <c>packageNotFound</c> when absent.</summary>
    Task<Package> GetPackageAsync(string id, bool prerelease, CancellationToken cancellationToken);

    /// <summary>Dependency groups for one package version; throws <c>packageNotFound</c> when absent.</summary>
    Task<PackageDetails> GetPackageDetailsAsync(
        string id,
        string version,
        CancellationToken cancellationToken);

    /// <summary>
    /// Supported frameworks for one package version, declared and compatible (the nuget.org
    /// Frameworks tab). Throws <c>packageNotFound</c> when the version cannot be obtained.
    /// </summary>
    Task<PackageFrameworks> GetPackageFrameworksAsync(
        string id,
        string version,
        CancellationToken cancellationToken);

    /// <summary>
    /// Whether each version of <paramref name="id"/> can be consumed by the given
    /// <paramref name="projectFrameworks"/> (target framework short names).
    ///
    /// Derived from the registration metadata's dependency groups, so no <c>.nupkg</c> is
    /// downloaded. A null or empty <paramref name="versions"/> means every version the feed
    /// lists; versions the feed does not list are omitted from the result. An unprovable
    /// answer is reported as <c>Known:false, Compatible:true</c> (fail open).
    /// </summary>
    Task<IReadOnlyList<PackageVersionCompatibility>> GetVersionCompatibilityAsync(
        string id,
        IReadOnlyList<string> projectFrameworks,
        IReadOnlyList<string>? versions,
        CancellationToken cancellationToken);

    /// <summary>Drops cached package metadata, for one id or (null) for everything.</summary>
    void ClearPackageCache(string? packageId = null);
}
