// File: tests/NugetPackageManager.Core.Workspace.Tests/Tools/LocalToolOutdatedResolverTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Latest-version selection: highest stable by default, prerelease only on request, never a
// downgrade or the version already pinned, one lookup per id + prerelease flag.

using NugetPackageManager.Core.Workspace.Tools;

namespace NugetPackageManager.Core.Workspace.Tests.Tools;

[TestClass]
public class LocalToolOutdatedResolverTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_PicksTheHighestStableVersion()
    {
        var source = new FakeVersionSource(["8.0.10", "9.0.1", "9.0.2", "10.0.0-preview.1"]);
        var resolver = new LocalToolOutdatedResolver(source);

        var result = await resolver.ResolveAsync("dotnet-ef", "8.0.10");

        Assert.IsTrue(result.UpdateAvailable);
        Assert.AreEqual("9.0.2", result.LatestVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_OffersPrereleaseOnlyWhenRequested()
    {
        var source = new FakeVersionSource(["9.0.1", "10.0.0-preview.1"]);
        var stable = new LocalToolOutdatedResolver(source);
        var prerelease = new LocalToolOutdatedResolver(source, allowPrerelease: true);

        Assert.AreEqual("9.0.1", (await stable.ResolveAsync("dotnet-ef", "8.0.10")).LatestVersion);
        Assert.AreEqual("10.0.0-preview.1", (await prerelease.ResolveAsync("dotnet-ef", "8.0.10")).LatestVersion);
        Assert.IsTrue(source.PrereleaseFlags.Contains(true));
        Assert.IsTrue(source.PrereleaseFlags.Contains(false));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_NeverOffersThePinnedVersionOrADowngrade()
    {
        var source = new FakeVersionSource(["8.0.10", "7.0.0", "6.0.0"]);
        var resolver = new LocalToolOutdatedResolver(source);

        var same = await resolver.ResolveAsync("dotnet-ef", "8.0.10");
        var ahead = await resolver.ResolveAsync("dotnet-ef", "9.0.0");

        Assert.IsFalse(same.UpdateAvailable);
        Assert.IsNull(same.LatestVersion);
        Assert.IsFalse(ahead.UpdateAvailable);
        Assert.IsNull(ahead.LatestVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_ReportsNoUpdateWhenTheSourceHasNothing()
    {
        var resolver = new LocalToolOutdatedResolver(new FakeVersionSource([]));

        var result = await resolver.ResolveAsync("dotnet-ef", "8.0.10");

        Assert.IsFalse(result.UpdateAvailable);
        Assert.IsNull(result.LatestVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_CachesPerIdAndPrereleaseFlag()
    {
        var source = new FakeVersionSource(["9.0.1"]);
        var resolver = new LocalToolOutdatedResolver(source);

        await resolver.ResolveAsync("dotnet-ef", "8.0.10");
        await resolver.ResolveAsync("dotnet-ef", "8.0.10");
        await resolver.ResolveAsync("dotnet-reportgenerator-globaltool", "5.3.11");

        Assert.AreEqual(2, source.Calls);
        Assert.AreEqual(2, resolver.CachedLookups);

        resolver.Clear();
        Assert.AreEqual(0, resolver.CachedLookups);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_IgnoresAnUnparseableCurrentVersion()
    {
        var resolver = new LocalToolOutdatedResolver(new FakeVersionSource(["9.0.1"]));

        var result = await resolver.ResolveAsync("dotnet-ef", "not-a-version");

        Assert.IsFalse(result.UpdateAvailable);
        Assert.IsNull(result.LatestVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveAsync_RequiresTheIdAndVersion()
    {
        var resolver = new LocalToolOutdatedResolver(new FakeVersionSource(["9.0.1"]));

        await Assert.ThrowsExactlyAsync<ArgumentException>(() => resolver.ResolveAsync(" ", "8.0.10"));
        await Assert.ThrowsExactlyAsync<ArgumentException>(() => resolver.ResolveAsync("dotnet-ef", " "));
    }

    /// <summary>A version source that answers from a fixed list and counts its calls.</summary>
    private sealed class FakeVersionSource(IReadOnlyList<string> versions) : ILocalToolVersionSource
    {
        public int Calls { get; private set; }

        public List<bool> PrereleaseFlags { get; } = [];

        public Task<IReadOnlyList<string>> GetVersionsAsync(
            string packageId,
            bool prerelease,
            CancellationToken cancellationToken)
        {
            Calls++;
            PrereleaseFlags.Add(prerelease);
            return Task.FromResult(versions);
        }
    }
}
