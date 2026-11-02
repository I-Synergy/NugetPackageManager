// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/PackageFrameworksBuilderTests.cs
// Traces: none — framework expansion mirrors nuget.org's Frameworks tab.

using NuGet.Frameworks;
using NugetPackageManager.Core.NuGet.Sources;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

[TestClass]
public class PackageFrameworksBuilderTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void Build_NetStandardAsset_ExpandsToEveryConsumingFramework()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles(["lib/netstandard2.0/Contoso.Sdk.dll"], isToolPackage: false);

        // .NET, .NET Core, .NET Standard and .NET Framework lead, newest products first.
        string[] leading = [".NET", ".NET Core", ".NET Standard", ".NET Framework"];
        CollectionAssert.AreEqual(
            leading,
            frameworks.Groups.Take(leading.Length).Select(group => group.Product).ToArray());

        var netStandard = frameworks.Groups.Single(group => group.Product == ".NET Standard");
        Assert.IsFalse(
            netStandard.Frameworks.Single(item => item.Name == "netstandard2.0").IsComputed,
            "the asset the package ships is declared");
        Assert.IsFalse(
            netStandard.Frameworks.Any(item => item.Name == "netstandard1.6"),
            "a netstandard1.x project cannot consume a netstandard2.0 asset");

        var net = frameworks.Groups.Single(group => group.Product == ".NET");
        Assert.IsTrue(net.Frameworks.Any(item => item.Name == "net8.0" && item.IsComputed));
        Assert.IsTrue(net.Frameworks.Any(item => item.Name == "net5.0" && item.IsComputed));

        // .NET Framework 4.6.1+ consumes netstandard2.0; 4.5 does not.
        var netFramework = frameworks.Groups.Single(group => group.Product == ".NET Framework");
        Assert.IsTrue(netFramework.Frameworks.Any(item => item.Name == "net481" && item.IsComputed));
        Assert.IsFalse(netFramework.Frameworks.Any(item => item.Name == "net45"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_SeveralAssets_MarksOnlyTheDeclaredOnes()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles(
            ["lib/net45/Contoso.Sdk.dll", "lib/netstandard2.0/Contoso.Sdk.dll"],
            isToolPackage: false);

        var netFramework = frameworks.Groups.Single(group => group.Product == ".NET Framework");
        Assert.IsFalse(netFramework.Frameworks.Single(item => item.Name == "net45").IsComputed);
        Assert.IsTrue(netFramework.Frameworks.Single(item => item.Name == "net48").IsComputed);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_PlatformVersionedAsset_KeepsTheDeclaredFrameworkAndDropsTheGenericTwin()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles(
            ["lib/net8.0-windows10.0.19041.0/Contoso.Sdk.dll"],
            isToolPackage: false);

        var net = frameworks.Groups.Single(group => group.Product == ".NET");
        var windows = net.Frameworks.Where(item => item.Name.StartsWith("net8.0-windows", StringComparison.Ordinal)).ToList();

        Assert.AreEqual(1, windows.Count, "the platform-agnostic twin must not duplicate the declared framework");
        Assert.AreEqual("net8.0-windows10.0.19041", windows[0].Name);
        Assert.IsFalse(windows[0].IsComputed);
        Assert.IsTrue(net.Frameworks.Any(item => item.Name == "net9.0-windows" && item.IsComputed));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_FoldersWithoutTypedAccessors_StillContributeFrameworks()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles(
            ["buildTransitive/net472/Contoso.Sdk.props", "runtimes/win-x64/lib/net8.0/Contoso.Sdk.dll"],
            isToolPackage: false);

        var netFramework = frameworks.Groups.Single(group => group.Product == ".NET Framework");
        Assert.IsFalse(netFramework.Frameworks.Single(item => item.Name == "net472").IsComputed);

        var net = frameworks.Groups.Single(group => group.Product == ".NET");
        Assert.IsFalse(net.Frameworks.Single(item => item.Name == "net8.0").IsComputed);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_ToolsPayload_OnlyCountsForToolPackages()
    {
        var library = PackageFrameworksBuilder.FromFiles(["tools/net6.0/any/Contoso.Sdk.dll"], isToolPackage: false);
        Assert.AreEqual(0, library.Groups.Count, "a tools/ payload of a library is not a framework declaration");

        var tool = PackageFrameworksBuilder.FromFiles(["tools/net6.0/any/Contoso.Sdk.dll"], isToolPackage: true);
        var net = tool.Groups.Single(group => group.Product == ".NET");
        Assert.IsFalse(net.Frameworks.Single(item => item.Name == "net6.0").IsComputed);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_DeclaredFrameworksFromTheReader_AreUsedAsIs()
    {
        var frameworks = PackageFrameworksBuilder.Build(["net6.0"], [], isToolPackage: false);

        var net = frameworks.Groups.Single(group => group.Product == ".NET");
        Assert.IsFalse(net.Frameworks.Single(item => item.Name == "net6.0").IsComputed);

        // A net7.0 project can consume a net6.0 asset; net5.0 cannot.
        Assert.IsTrue(net.Frameworks.Single(item => item.Name == "net7.0").IsComputed);
        Assert.IsFalse(net.Frameworks.Any(item => item.Name == "net5.0"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_UnsupportedAndPortableFrameworks_AreSkipped()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles(
            ["lib/any/Contoso.Sdk.dll", "lib/portable-net45+win8/Contoso.Sdk.dll"],
            isToolPackage: false);

        Assert.AreEqual(0, frameworks.Groups.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Build_PackageWithoutAssets_ReportsNoGroups()
    {
        var frameworks = PackageFrameworksBuilder.FromFiles([], isToolPackage: false);

        Assert.AreEqual(0, frameworks.Groups.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Expand_PrecedenceGroupsSortWithTheFrameworkSorter()
    {
        var frameworks = PackageFrameworksBuilder.Expand(
            [NuGetFramework.ParseFolder("netstandard2.0"), NuGetFramework.ParseFolder("net45")]);

        var products = frameworks.Groups.Select(group => group.Product).ToList();
        string[] leading = [".NET", ".NET Core", ".NET Standard", ".NET Framework"];
        CollectionAssert.AreEqual(
            leading,
            products.Take(leading.Length).ToArray());

        // Products past the four known ones are alphabetical.
        CollectionAssert.AreEqual(
            products.Skip(leading.Length).OrderBy(product => product, StringComparer.OrdinalIgnoreCase).ToArray(),
            products.Skip(leading.Length).ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Expand_DeclaredNetStandard_TurnsUpAsDeclaredNotComputed()
    {
        var frameworks = PackageFrameworksBuilder.Expand([NuGetFramework.ParseFolder("netstandard2.0")]);

        var item = frameworks.Groups
            .Single(group => group.Product == ".NET Standard")
            .Frameworks
            .Single(entry => entry.Name == "netstandard2.0");

        Assert.IsFalse(item.IsComputed);
    }
}
