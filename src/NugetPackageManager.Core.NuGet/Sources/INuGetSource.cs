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

    Task<PackageDetails> GetPackageDetailsAsync(string packageVersionUrl, CancellationToken cancellationToken);

    /// <summary>Drops cached package metadata, for one id or (null) for everything.</summary>
    void ClearPackageCache(string? packageId = null);
}
