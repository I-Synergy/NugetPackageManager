using NuGet.Protocol.Core.Types;
using NuGet.Versioning;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// Turns official <c>NuGet.Protocol</c> metadata into the shapes the RPC carries.
///
/// Kept separate from the source so it can be tested without HTTP. The one rule worth stating:
/// a value the resource does not publish is <c>null</c>, never <c>0</c>/<c>false</c> — the
/// registration resource has no download count or verified-owner flag, and pretending it does is
/// exactly the bug this layer replaced.
/// </summary>
internal static class PackageMetadataMapper
{
    /// <summary>Versions the source offers, highest last; stable only unless prerelease is allowed.</summary>
    public static List<IPackageSearchMetadata> Eligible(IEnumerable<IPackageSearchMetadata> all, bool prerelease)
    {
        var ordered = all.OrderBy(metadata => metadata.Identity.Version, VersionComparer.VersionRelease).ToList();
        if (prerelease)
        {
            return ordered;
        }

        var stable = ordered.Where(metadata => !metadata.Identity.Version.IsPrerelease).ToList();
        return stable.Count > 0 ? stable : ordered;
    }

    public static Package ToPackage(
        IPackageSearchMetadata metadata,
        IReadOnlyList<NuGetVersion> versions,
        long? totalDownloads,
        bool? verified)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        return new Package
        {
            Id = metadata.Identity.Id,
            Name = metadata.Identity.Id,
            Authors = SplitAuthors(metadata.Authors),
            Description = metadata.Description ?? string.Empty,
            IconUrl = metadata.IconUrl?.ToString() ?? string.Empty,
            LicenseUrl = metadata.LicenseUrl?.ToString() ?? string.Empty,
            ProjectUrl = metadata.ProjectUrl?.ToString() ?? string.Empty,
            // The registration URL is no longer part of the contract: NuGet.Protocol addresses
            // packages by id + version, and so does the details request now.
            Registration = string.Empty,
            TotalDownloads = totalDownloads,
            Verified = verified,
            InstalledVersion = string.Empty,
            Version = metadata.Identity.Version.ToNormalizedString(),
            Versions = [.. versions.Select(version => new PackageVersionRef(version.ToNormalizedString()))],
            Tags = SplitTags(metadata.Tags),
        };
    }

    public static PackageDetails ToDetails(IPackageSearchMetadata metadata)
    {
        ArgumentNullException.ThrowIfNull(metadata);

        var frameworks = new Dictionary<string, List<PackageDependency>>(StringComparer.Ordinal);
        foreach (var set in metadata.DependencySets ?? [])
        {
            var framework = set.TargetFramework?.ToString() ?? string.Empty;
            frameworks[framework] =
            [
                .. set.Packages.Select(dependency => new PackageDependency
                {
                    Package = dependency.Id,
                    VersionRange = dependency.VersionRange?.ToString() ?? string.Empty,
                }),
            ];
        }

        return new PackageDetails
        {
            Dependencies = new PackageDependencyGroup { Frameworks = frameworks },
        };
    }

    // NuGet.Protocol exposes tags as one string (the nuspec spelling), not a list.
    private static List<string> SplitTags(string? tags) =>
        string.IsNullOrWhiteSpace(tags)
            ? []
            : [.. tags.Split([' ', ',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)];

    private static List<string> SplitAuthors(string? authors) =>
        string.IsNullOrWhiteSpace(authors)
            ? []
            : [.. authors.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)];
}
