// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/ProtocolNuGetSourceTests.cs
// Traces: issue #45 — Downloads/Verified come from the search resource, not registration.

using System.IO.Compression;
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
            _ => Task.FromResult<PackageMetadataResource?>(null),
            _ => Task.FromResult<DownloadResource?>(null));

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
    public async Task GetPackageAsync_PrereleaseOnlyPackageIsFoundWhenTheFilterIsOff()
    {
        // An installed prerelease package (Aspire.Hosting.Maui, Microsoft.Maui.DevFlow.Agent,
        // …) must resolve even when the global Prerelease toggle is off. Asking the metadata
        // resource with includePrerelease=false hides every version, so the package was reported
        // as missing from each configured feed.
        using var source = CreateSource(registered: [Metadata("13.0.0-preview.1.25560.3")]);

        var package = await source.GetPackageAsync("Aspire.Hosting.Maui", prerelease: false, CancellationToken.None);

        Assert.AreEqual("13.0.0-preview.1.25560.3", package.Version);
        string[] expected = ["13.0.0-preview.1.25560.3"];
        CollectionAssert.AreEqual(
            expected,
            package.Versions.Select(version => version.Version).ToArray());
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

    [TestMethod]
    [TestCategory("Unit")]
    public async Task SearchAsync_MapsTheDownloadCountOfEveryVersion()
    {
        var hit = Metadata("13.0.3", downloads: 300, versions:
        [
            new VersionInfo(NuGetVersion.Parse("12.0.1"), 111),
            new VersionInfo(NuGetVersion.Parse("13.0.3"), 222),
        ]);
        using var source = CreateSource(searchHits: [hit]);

        var packages = await source.SearchAsync("json", prerelease: false, 0, 20, CancellationToken.None);

        var versions = packages[0].Versions;
        Assert.AreEqual("12.0.1", versions[0].Version);
        Assert.AreEqual(111L, versions[0].Downloads);
        Assert.AreEqual("13.0.3", versions[1].Version);
        Assert.AreEqual(222L, versions[1].Downloads);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_MergesVersionDownloadsFromTheSearchLookup()
    {
        // Registration supplies the version list; only the search hit knows the counts.
        var popularity = Metadata("13.0.3", downloads: 500, versions:
        [
            new VersionInfo(NuGetVersion.Parse("12.0.1"), 5),
            new VersionInfo(NuGetVersion.Parse("13.0.3"), 7),
            new VersionInfo(NuGetVersion.Parse("14.0.0"), 9),
        ]);
        using var source = CreateSource(
            registered: [Metadata("12.0.1"), Metadata("13.0.3")],
            searchHits: [popularity]);

        var package = await source.GetPackageAsync("Contoso.Sdk", prerelease: false, CancellationToken.None);

        Assert.AreEqual(500L, package.TotalDownloads);
        long?[] expected = [5, 7];
        CollectionAssert.AreEqual(
            expected,
            package.Versions.Select(version => version.Downloads).ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageAsync_WithoutSearchSupport_LeavesVersionDownloadsUnknown()
    {
        using var source = CreateSource(registered: [Metadata("12.0.1"), Metadata("13.0.3")], searchThrows: true);

        var package = await source.GetPackageAsync("Contoso.Sdk", prerelease: false, CancellationToken.None);

        Assert.AreEqual(2, package.Versions.Count);
        Assert.IsTrue(package.Versions.All(version => version.Downloads is null));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageFrameworksAsync_ExpandsTheDeclaredFramework()
    {
        using var source = CreateSource(downloadResource: Download(PackageDownload("lib/netstandard2.0/Contoso.Sdk.dll")));

        var frameworks = await source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None);

        var netStandard = frameworks.Groups.Single(group => group.Product == ".NET Standard");
        var declared = netStandard.Frameworks.Single(item => item.Name == "netstandard2.0");
        Assert.IsFalse(declared.IsComputed, "an asset the package ships is declared");

        var net = frameworks.Groups.Single(group => group.Product == ".NET");
        Assert.IsTrue(net.Frameworks.Any(item => item.Name == "net8.0" && item.IsComputed));
        Assert.IsTrue(net.Frameworks.Any(item => item.Name == "net5.0" && item.IsComputed));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageFrameworksAsync_PassesTheGlobalPackagesFolderToTheDownload()
    {
        // DownloadResource throws ArgumentNullException when globalPackagesFolder is null, which
        // made every Frameworks tab fail with a generic download error.
        var download = PackageDownload("lib/netstandard2.0/Contoso.Sdk.dll");
        using var source = CreateSource(downloadResource: Download(download));

        await source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None);

        Assert.IsFalse(
            string.IsNullOrWhiteSpace(download.GlobalPackagesFolder),
            "DownloadResource requires a non-null global packages folder");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageFrameworksAsync_CachesPerVersion()
    {
        var download = PackageDownload("lib/netstandard2.0/Contoso.Sdk.dll");
        using var source = CreateSource(downloadResource: Download(download));

        await source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None);
        await source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None);
        Assert.AreEqual(1, download.Calls, "the second request should come from the cache");

        source.ClearPackageCache("Contoso.Sdk");
        await source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None);
        Assert.AreEqual(2, download.Calls);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageFrameworksAsync_UnavailablePackage_ReportsPackageNotFound()
    {
        using var source = CreateSource(downloadResource: Download(new FakeDownloadResource(
            _ => new DownloadResourceResult(DownloadResourceResultStatus.NotFound))));

        var error = await Assert.ThrowsExactlyAsync<NuGetSourceException>(
            () => source.GetPackageFrameworksAsync("Contoso.Sdk", "1.0.0", CancellationToken.None));

        Assert.AreEqual("packageNotFound", error.Code);
    }

    private static readonly string[] stableOnly = ["12.0.1"];

    private const string Manifest = """
        <?xml version="1.0" encoding="utf-8"?>
        <package>
          <metadata>
            <id>Contoso.Sdk</id>
            <version>1.0.0</version>
            <authors>Contoso</authors>
            <description>A test package</description>
          </metadata>
        </package>
        """;

    private static Func<CancellationToken, Task<DownloadResource?>> Download(DownloadResource resource) =>
        _ => Task.FromResult<DownloadResource?>(resource);

    private static FakeDownloadResource PackageDownload(params string[] entries)
    {
        var bytes = PackageBytes(["Contoso.Sdk.nuspec", .. entries]);
        return new FakeDownloadResource(_ => new DownloadResourceResult(
            new PackageArchiveReader(new MemoryStream(bytes)),
            SourceUrl));
    }

    private static byte[] PackageBytes(IEnumerable<string> entries)
    {
        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach (var entry in entries)
            {
                var zipEntry = archive.CreateEntry(entry);
                using var writer = new StreamWriter(zipEntry.Open());
                writer.Write(entry.EndsWith(".nuspec", StringComparison.OrdinalIgnoreCase) ? Manifest : entry);
            }
        }

        return stream.ToArray();
    }

    private static ProtocolNuGetSource CreateSource(
        IEnumerable<IPackageSearchMetadata>? registered = null,
        IEnumerable<IPackageSearchMetadata>? searchHits = null,
        bool searchThrows = false,
        FakeMetadataResource? metadataResource = null,
        Func<CancellationToken, Task<DownloadResource?>>? downloadResource = null)
    {
        var entries = (registered ?? []).ToList();
        var metadata = metadataResource ?? new FakeMetadataResource(_ => entries);

        return new ProtocolNuGetSource(
            SourceUrl,
            _ => searchThrows
                ? throw new NuGetSourceException("sourceUnreachable", "no search")
                : Task.FromResult<PackageSearchResource?>(new FakeSearchResource(searchHits ?? [])),
            _ => Task.FromResult<PackageMetadataResource?>(metadata),
            downloadResource ?? (_ => Task.FromResult<DownloadResource?>(null)));
    }

    private static FakePackageMetadata Metadata(
        string version,
        long? downloads = null,
        bool verified = false,
        IEnumerable<PackageDependencyGroup>? dependencySets = null,
        IReadOnlyList<VersionInfo>? versions = null) =>
        new()
        {
            Identity = new PackageIdentity("Contoso.Sdk", NuGetVersion.Parse(version)),
            Description = "A test package",
            Authors = "Contoso, Someone Else",
            Tags = "json test",
            DownloadCount = downloads,
            PrefixReserved = verified,
            DependencySets = dependencySets ?? [],
            Versions = versions ?? [new VersionInfo(NuGetVersion.Parse(version), downloads)],
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
            var entriesForPackage = entries(packageIdentifier);
            return Task.FromResult(includePrerelease
                ? entriesForPackage
                : entriesForPackage.Where(metadata => !metadata.Identity.Version.IsPrerelease));
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

    private sealed class FakeDownloadResource(Func<PackageIdentity, DownloadResourceResult> result)
        : DownloadResource
    {
        public int Calls { get; private set; }

        public string? GlobalPackagesFolder { get; private set; }

        public override Task<DownloadResourceResult> GetDownloadResourceResultAsync(
            PackageIdentity identity,
            PackageDownloadContext downloadContext,
            string globalPackagesFolder,
            ILogger logger,
            CancellationToken token)
        {
            Calls++;
            GlobalPackagesFolder = globalPackagesFolder;
            return Task.FromResult(result(identity));
        }
    }
}
