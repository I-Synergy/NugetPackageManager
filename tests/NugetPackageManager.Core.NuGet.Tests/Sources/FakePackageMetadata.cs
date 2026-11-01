// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/FakePackageMetadata.cs
// Traces: none — test double for the official metadata interfaces.

using NuGet.Packaging;
using NuGet.Packaging.Core;
using NuGet.Protocol;
using NuGet.Protocol.Core.Types;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

/// <summary>One <see cref="IPackageSearchMetadata"/> with only the fields the mapper reads set.</summary>
internal sealed class FakePackageMetadata : IPackageSearchMetadata
{
    public required PackageIdentity Identity { get; init; }

    public string Authors { get; init; } = string.Empty;

    public string Description { get; init; } = string.Empty;

    public string Tags { get; init; } = string.Empty;

    public long? DownloadCount { get; init; }

    public bool PrefixReserved { get; init; }

    public Uri? IconUrl { get; init; }

    public Uri? LicenseUrl { get; init; }

    public Uri? ProjectUrl { get; init; }

    public IEnumerable<PackageDependencyGroup> DependencySets { get; init; } = [];

    public Task<IEnumerable<VersionInfo>> GetVersionsAsync() =>
        Task.FromResult<IEnumerable<VersionInfo>>([new VersionInfo(Identity.Version)]);

    public string? Title => Identity.Id;

    public string? Summary => null;

    string? IPackageSearchMetadata.Description => Description;

    public string? Owners => null;

    public IReadOnlyList<string> OwnersList => [];

    public Uri? ReadmeUrl => null;

    public string? ReadmeFileUrl => null;

    public Uri? ReportAbuseUrl => null;

    public Uri? PackageDetailsUrl => null;

    public DateTimeOffset? Published => null;

    public bool RequireLicenseAcceptance => false;

    public bool IsListed => true;

    public LicenseMetadata? LicenseMetadata => null;

    public IEnumerable<PackageVulnerabilityMetadata> Vulnerabilities => [];

    public Task<PackageDeprecationMetadata?> GetDeprecationMetadataAsync() =>
        Task.FromResult<PackageDeprecationMetadata?>(null);
}
