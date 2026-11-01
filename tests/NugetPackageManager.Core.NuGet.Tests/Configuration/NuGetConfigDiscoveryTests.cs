// File: tests/NugetPackageManager.Core.NuGet.Tests/Configuration/NuGetConfigDiscoveryTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Ports the discovery-order half of the TypeScript `nuget-config-resolver.test.ts`: machine →
// user → workspace, with the file-system probe injected.

using NugetPackageManager.Core.NuGet.Configuration;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.NuGet.Tests.Configuration;

[TestClass]
public class NuGetConfigDiscoveryTests
{
    private static NuGetConfigEnvironment Env(string platform, string home, params (string Name, string Value)[] variables) =>
        new(platform, home, name => variables
            .Where(variable => variable.Name == name)
            .Select(variable => variable.Value)
            .FirstOrDefault());

    [TestMethod]
    [TestCategory("Unit")]
    public void Discover_Windows_ReadsMachineThenUserThenWorkspace()
    {
        var home = Path.Combine("C:", "Users", "dev");
        var programFiles = Path.Combine("C:", "Program Files (x86)");
        var appData = Path.Combine(home, "AppData", "Roaming");
        var machine = Path.Combine(programFiles, "NuGet", "Config", "Microsoft.VisualStudio.Offline.config");
        var user = Path.Combine(home, ".nuget", "NuGet", "NuGet.Config");
        var roaming = Path.Combine(appData, "NuGet", "NuGet.Config");
        var workspace = Path.Combine("D:", "repo");
        var workspaceConfig = Path.Combine(workspace, "nuget.config");

        var existing = new HashSet<string>([machine, user, roaming, workspaceConfig], StringComparer.Ordinal);
        var environment = Env(
            "win32",
            home,
            ("ProgramFiles(x86)", programFiles),
            ("ProgramFiles", Path.Combine("C:", "Program Files")),
            ("APPDATA", appData));

        var locations = NuGetConfigDiscovery.Discover(environment, [workspace], existing.Contains);

        CollectionAssert.AreEqual(
            new[] { machine, user, roaming, workspaceConfig },
            locations.Select(location => location.Path).ToArray());
        Assert.IsFalse(locations[0].IsWorkspace);
        Assert.IsFalse(locations[1].IsWorkspace);
        Assert.IsFalse(locations[2].IsWorkspace);
        Assert.IsTrue(locations[3].IsWorkspace);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Discover_Unix_ReadsDotConfigBeforeDotNugetAndSkipsWindowsLocations()
    {
        var home = Path.Combine("/home", "dev");
        var dotConfig = Path.Combine(home, ".config", "NuGet", "NuGet.Config");
        var dotNuget = Path.Combine(home, ".nuget", "NuGet", "NuGet.Config");

        var existing = new HashSet<string>([dotConfig, dotNuget], StringComparer.Ordinal);
        var environment = Env("linux", home, ("APPDATA", "/should/not/be/used"));

        var locations = NuGetConfigDiscovery.Discover(environment, [], existing.Contains);

        CollectionAssert.AreEqual(new[] { dotConfig, dotNuget }, locations.Select(location => location.Path).ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Discover_ProgramFilesFallback_UsesTheNonX86Variable()
    {
        var programFiles = Path.Combine("C:", "Program Files");
        var machine = Path.Combine(programFiles, "NuGet", "Config", "Microsoft.VisualStudio.Offline.config");
        var existing = new HashSet<string>([machine], StringComparer.Ordinal);

        var environment = Env(
            "win32",
            Path.Combine("C:", "Users", "dev"),
            ("ProgramFiles(x86)", string.Empty),
            ("ProgramFiles", programFiles));

        var locations = NuGetConfigDiscovery.Discover(environment, [], existing.Contains);

        CollectionAssert.AreEqual(new[] { machine }, locations.Select(location => location.Path).ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Discover_MissingFiles_AreSkipped()
    {
        var environment = Env("linux", Path.Combine("/home", "dev"));

        var locations = NuGetConfigDiscovery.Discover(environment, [], _ => false);

        Assert.AreEqual(0, locations.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void CollectWorkspaceConfigFiles_PrefersTheDotNugetFolderOverTheRoot()
    {
        var workspace = Path.Combine("D:", "repo");
        var nested = Path.Combine(workspace, ".nuget", "nuget.config");
        var root = Path.Combine(workspace, "nuget.config");

        var existing = new HashSet<string>([nested, root], StringComparer.Ordinal);

        var paths = NuGetConfigDiscovery.CollectWorkspaceConfigFiles([workspace], existing.Contains);

        CollectionAssert.AreEqual(new[] { nested, root }, paths.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void CollectWorkspaceConfigFiles_AcceptsTheCaseVariantsAndEveryRoot()
    {
        var first = Path.Combine("D:", "one");
        var second = Path.Combine("E:", "two");
        var firstConfig = Path.Combine(first, "NuGet.Config");
        var secondNested = Path.Combine(second, ".nuget", "NuGet.config");

        var existing = new HashSet<string>([firstConfig, secondNested], StringComparer.Ordinal);

        var paths = NuGetConfigDiscovery.CollectWorkspaceConfigFiles([first, second], existing.Contains);

        CollectionAssert.AreEqual(new[] { firstConfig, secondNested }, paths.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Discover_ReadsTheRealMachineLayout_FromATemporaryWorkspace()
    {
        using var workspace = new TemporaryDirectory("nuget-config-discovery");
        var config = workspace.WriteFile("nuget.config", "<configuration />");
        var environment = Env("linux", workspace.CreateDirectory("home"));

        var locations = NuGetConfigDiscovery.Discover(environment, [workspace.Root]);

        Assert.AreEqual(1, locations.Count);
        Assert.AreEqual(config, locations[0].Path);
        Assert.IsTrue(locations[0].IsWorkspace);
    }
}
