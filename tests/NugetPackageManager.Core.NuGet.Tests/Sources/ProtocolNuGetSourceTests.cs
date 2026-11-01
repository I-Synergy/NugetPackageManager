// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/ProtocolNuGetSourceTests.cs
// Traces: issue #45 — Downloads/Verified come from the search resource, not registration.

using NuGet.Common;
using NuGet.Frameworks;
using NuGet.Packaging;
using NuGet.Packaging.Core;
using NuGet.Protocol.Core.Types;
using NuGet.Versioning;
using NugetPackageManager.Core.NuGet.Sources;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

[TestClass]
public class ProtocolNuGetSourceTests
{
    private const string SourceUrl = "https://example.test/v3/index.json";

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_TakesPopularityFromTheSearchResource()
    {
        // Registration carries no download count and no verified flag; the search hit does.
        using var source = CreateSource(
            registered: [Metadata("13.0.3")],
            searchHits: [Metadata("13.0.3", downloads: 9_678_449_573, verified: true)]);

        var package = await source.GetPackageAsync("Contoso.Sdk", prerelease: false, CancellationToken.None);

        Assert.AreEqual(9_678_449_573L, package.TotalDownloads);
        Assert.AreEqual(true, package.Verified);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_WithoutSearchSupport_LeavesPopularityUnknown()
    {
        // A feed with no SearchQueryService must still resolve packages; the fields stay null
        // rather than a wrong 0/false (the #45 bug).
        using var source = CreateSource(registered: [Metadata("13.0.3")], searchThrows: true);

        var package = await source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None);

        Assert.IsNull(package.TotalDownloads);
        Assert.IsNull(package.Verified);
        Assert.AreEqual("13.0.3", package.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_MissingPackage_ReportsPackageNotFound()
    {
        using var source = CreateSource(registered: []);

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageAsync("does.not.exist", prerelease: false, CancellationToken.None));

        Assert.AreEqual("packageNotFound", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_WithoutTheMetadataResource_ReportsSourceUnreachable()
    {
        using var source = new ProtocolNuGetSource(
            SourceUrl,
            _ => Task.FromResult<PackageSearchResource?>(new FakeSearchResource([])),
            _ => Task.FromResult<PackageMetadataResource?>(null));

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None));

        Assert.AreEqual("sourceUnreachable", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_PrefersStableVersions()
    {
        using var source = CreateSource(registered: [Metadata("12.0.1"), Metadata("13.0.0-beta1")]);

        var package = await source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None);

        Assert.AreEqual("12.0.1", package.Version);
        CollectionAssert.AreEqual(stableOnly, package.Versions.Select(version => version.Version).ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_AllowsPrereleaseWhenAsked()
    {
        using var source = CreateSource(registered: [Metadata("12.0.1"), Metadata("13.0.0-beta1")]);

        var package = await source.GetPackageAsync("Newtonsoft.Json", prerelease: true, CancellationToken.None);

        Assert.AreEqual("13.0.0-beta1", package.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_CachesUntilCleared()
    {
        var metadata = new FakeMetadataResource(_ => [Metadata("13.0.3")]);
        using var source = CreateSource(metadataResource: metadata);

        await source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None);
        await source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None);
        Assert.AreEqual(1, metadata.Calls, "the second lookup should come from the cache");

        source.ClearPackageCache("Newtonsoft.Json");
        await source.GetPackageAsync("Newtonsoft.Json", prerelease: false, CancellationToken.None);
        Assert.AreEqual(2, metadata.Calls);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageDetailsAsync_KeepsThePerFrameworkGroups()
    {
        var group = new PackageDependencyGroup(
            NuGetFramework.Parse("net8.0"),
            [new PackageDependency("Newtonsoft.Json", VersionRange.Parse("[13.0.0, )"))]);
        using var source = CreateSource(registered: [Metadata("13.0.3", dependencySets: [group])]);

        var details = await source.GetPackageDetailsAsync("Contoso.Sdk", "13.0.3", CancellationToken.None);

        Assert.IsTrue(details.Dependencies.Frameworks.ContainsKey("net8.0"));
        Assert.AreEqual("Newtonsoft.Json", details.Dependencies.Frameworks["net8.0"][0].Package);
        Assert.AreEqual("[13.0.0, )", details.Dependencies.Frameworks["net8.0"][0].VersionRange);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageDetailsAsync_UnknownVersion_ReportsPackageNotFound()
    {
        using var source = CreateSource(registered: [Metadata("13.0.3")]);

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageDetailsAsync("Contoso.Sdk", "1.0.0", CancellationToken.None));

        Assert.AreEqual("packageNotFound", error.Code);
    }

    private static readonly string[] stableOnly = ["12.0.1"];

    private static ProtocolNuGetSource CreateSource(
        IEnumerable<IPackageSearchMetadata>? registered = null,
        IEnumerable<IPackageSearchMetadata>? searchHits = null,
        bool searchThrows = false,
        FakeMetadataResource? metadataResource = null)
    {
        var entries = (registered ?? []).ToList();
        var metadata = metadataResource ?? new FakeMetadataResource(_ => entries);

        return new ProtocolNuGetSource(
            SourceUrl,
            _ => searchThrows
                ? throw new NuGetSourceException("sourceUnreachable", "no search")
                : Task.FromResult<PackageSearchResource?>(new FakeSearchResource(searchHits ?? [])),
            _ => Task.FromResult<PackageMetadataResource?>(metadata));
    }

    private static FakePackageMetadata Metadata(
        string version,
        long? downloads = null,
        bool verified = false,
        IEnumerable<PackageDependencyGroup>? dependencySets = null) =>
        new()
        {
            Identity = new PackageIdentity("Contoso.Sdk", NuGetVersion.Parse(version)),
            Description = "A test package",
            Authors = "Contoso, Someone Else",
            Tags = "json test",
            DownloadCount = downloads,
            PrefixReserved = verified,
            DependencySets = dependencySets ?? [],
        };

    private sealed class FakeMetadataResource(Func<string, IEnumerable<IPackageSearchMetadata>> entries)
        : PackageMetadataResource
    {
        public int Calls { get; private set; }

        public override Task<IEnumerable<IPackageSearchMetadata>> GetMetadataAsync(
            string packageIdentifier,
            bool includePrerelease,
            bool includeUnlisted,
            SourceCacheContext sourceCacheContext,
            ILogger log,
            CancellationToken token)
        {
            Calls++;
            return Task.FromResult(entries(packageIdentifier));
        }

        public override Task<IPackageSearchMetadata?> GetMetadataAsync(
            PackageIdentity identity,
            SourceCacheContext sourceCacheContext,
            ILogger log,
            CancellationToken token) =>
            Task.FromResult<IPackageSearchMetadata?>(null);
    }

    private sealed class FakeSearchResource(IEnumerable<IPackageSearchMetadata> results) : PackageSearchResource
    {
        public override bool SupportsPackageTypeFiltering => true;

        public override Task<IEnumerable<IPackageSearchMetadata>> SearchAsync(
            string searchTerm,
            SearchFilter filters,
            int skip,
            int take,
            ILogger log,
            CancellationToken token) =>
            Task.FromResult(results);
    }
}
