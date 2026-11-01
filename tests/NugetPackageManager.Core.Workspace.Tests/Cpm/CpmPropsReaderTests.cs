// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmPropsReaderTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors the read half of `cpm-resolver.test.ts`, and runs the repository's own
// `Fixtures/cpm` props files through the ported reader.

using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
public class CpmPropsReaderTests
{
    private const string SingleGroup = """
        <Project>
          <PropertyGroup>
            <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
          </PropertyGroup>
          <ItemGroup>
            <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
            <PackageVersion Include="Serilog" Version="2.11.0" />
          </ItemGroup>
        </Project>
        """;

    private const string ConditionalGroups = """
        <Project>
          <PropertyGroup>
            <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
          </PropertyGroup>
          <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
            <PackageVersion Include="Pkg.Shared" Version="10.0.1" />
          </ItemGroup>
          <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
            <PackageVersion Include="Pkg.Shared" Version="11.0.0" />
          </ItemGroup>
        </Project>
        """;

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_UnconditionalGroup_FillsTheFlatMap()
    {
        // Act
        var map = CpmPropsReader.Parse(SingleGroup);

        // Assert
        Assert.AreEqual(2, map.Unconditional.Count);
        Assert.AreEqual("13.0.3", map.Unconditional["Newtonsoft.Json"]);
        Assert.AreEqual("2.11.0", map.Unconditional["Serilog"]);
        Assert.AreEqual(0, map.Conditional.Count);
        Assert.IsFalse(map.HasConditionalGroups);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ConditionalGroups_KeepTheirConditionAndLabel()
    {
        // Act
        var map = CpmPropsReader.Parse(ConditionalGroups);

        // Assert
        Assert.IsTrue(map.HasConditionalGroups);
        Assert.AreEqual(0, map.Unconditional.Count);
        Assert.AreEqual(2, map.Conditional.Count);
        Assert.AreEqual("net10.0", map.Conditional[0].Framework);
        Assert.AreEqual("net11.0", map.Conditional[1].Framework);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ElementCondition_IsCombinedWithTheGroupCondition()
    {
        // Arrange
        const string content = """
            <Project>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Pkg" Version="1.0.0" Condition="'$(Configuration)' == 'Release'" />
              </ItemGroup>
            </Project>
            """;

        // Act
        var map = CpmPropsReader.Parse(content);

        // Assert
        Assert.AreEqual(1, map.Conditional.Count);
        Assert.AreEqual(
            "('$(TargetFramework)' == 'net10.0') And ('$(Configuration)' == 'Release')",
            map.Conditional[0].Condition);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ReadFlatVersions_IgnoresConditionsAndLastOneWins()
    {
        // Act
        var versions = CpmPropsReader.ReadFlatVersions(ConditionalGroups);

        // Assert — the TypeScript XPath selects every PackageVersion, so 11.0.0 wins.
        Assert.AreEqual(1, versions.Count);
        Assert.AreEqual("11.0.0", versions["Pkg.Shared"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_OneRowPerFrameworkLine()
    {
        // Arrange
        var map = CpmPropsReader.Parse(ConditionalGroups);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["Pkg.Shared"], ["net10.0", "net11.0"]);

        // Assert
        Assert.AreEqual(2, resolved["Pkg.Shared"].Count);
        Assert.AreEqual("10.0.1", resolved["Pkg.Shared"][0].Version);
        Assert.AreEqual("net10.0", resolved["Pkg.Shared"][0].Tfm);
        Assert.AreEqual("11.0.0", resolved["Pkg.Shared"][1].Version);
        Assert.IsTrue(resolved["Pkg.Shared"].All(resolution => resolution.Matched));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_ConditionMatchingSeveralTfms_YieldsOneRow()
    {
        // Arrange
        const string content = """
            <Project>
              <ItemGroup Condition="$(TargetFramework.StartsWith('net1'))">
                <PackageVersion Include="Pkg" Version="9.9.9" />
              </ItemGroup>
            </Project>
            """;
        var map = CpmPropsReader.Parse(content);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["Pkg"], ["net10.0", "net11.0"]);

        // Assert — same condition, so one version line even though it matches twice.
        Assert.AreEqual(1, resolved["Pkg"].Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_NoMatchingCondition_IsNotReported()
    {
        // Arrange
        var map = CpmPropsReader.Parse(ConditionalGroups);

        // Act — net12.0 matches neither group, but both are decidable, so nothing is shown.
        var resolved = CpmPropsReader.ResolveVersions(map, ["Pkg.Shared"], ["net12.0"]);

        // Assert
        Assert.IsFalse(resolved.ContainsKey("Pkg.Shared"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_UnknownCondition_IsReportedUnmatched()
    {
        // Arrange
        const string content = """
            <Project>
              <ItemGroup Condition="$([MSBuild]::VersionGreaterThanOrEquals('$(TargetFrameworkVersion)', 'v11.0'))">
                <PackageVersion Include="Pkg.Unsupported" Version="3.0.0" />
              </ItemGroup>
            </Project>
            """;
        var map = CpmPropsReader.Parse(content);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["Pkg.Unsupported"], ["net10.0"]);

        // Assert
        Assert.AreEqual(1, resolved["Pkg.Unsupported"].Count);
        Assert.IsFalse(resolved["Pkg.Unsupported"][0].Matched);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_NoTfms_ListsEveryGroupAsItsOwnLine()
    {
        // Arrange
        var map = CpmPropsReader.Parse(ConditionalGroups);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["Pkg.Shared"], []);

        // Assert
        Assert.AreEqual(2, resolved["Pkg.Shared"].Count);
        Assert.AreEqual("net10.0", resolved["Pkg.Shared"][0].Tfm);
        Assert.AreEqual("net11.0", resolved["Pkg.Shared"][1].Tfm);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_UnconditionalVersion_IsSharedAcrossTfms()
    {
        // Arrange
        var map = CpmPropsReader.Parse(SingleGroup);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["Newtonsoft.Json"], ["net10.0", "net11.0"]);

        // Assert
        Assert.AreEqual(1, resolved["Newtonsoft.Json"].Count);
        Assert.AreEqual(string.Empty, resolved["Newtonsoft.Json"][0].Tfm);
        Assert.AreEqual("13.0.3", resolved["Newtonsoft.Json"][0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ResolveVersions_PackageIdLookup_IsCaseInsensitive()
    {
        // Arrange
        var map = CpmPropsReader.Parse(SingleGroup);

        // Act
        var resolved = CpmPropsReader.ResolveVersions(map, ["newtonsoft.json"], ["net10.0"]);

        // Assert
        Assert.AreEqual("13.0.3", resolved["newtonsoft.json"][0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void HasPackage_ReportsBothKindsOfVersionLine()
    {
        // Arrange
        var map = CpmPropsReader.Parse(ConditionalGroups);

        // Assert
        Assert.IsTrue(CpmPropsReader.HasPackage(map, "Pkg.Shared"));
        Assert.IsFalse(CpmPropsReader.HasPackage(map, "Not.There"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetPackageVersions_ProjectUnderPropsFile_ReturnsTheFlatMap()
    {
        // Arrange
        using var workspace = new TemporaryDirectory("cpm-resolve");
        workspace.WriteFile("Directory.Packages.props", SingleGroup);
        var projectPath = workspace.WriteFile(
            Path.Combine("src", "App", "App.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        // Act
        var versions = CpmPropsReader.GetPackageVersions(projectPath);

        // Assert
        Assert.IsNotNull(versions);
        Assert.AreEqual("13.0.3", versions["Newtonsoft.Json"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetPackageVersions_FixtureWithoutPropsFile_ReturnsNull()
    {
        // The checked-in fixtures declare CPM inline and have no Directory.Packages.props above
        // them, so there is nothing to resolve — null is the correct answer, not an empty map.
        var project = TestPaths.Fixture("projects", "net10", "net10.csproj");

        Assert.IsNull(CpmPropsReader.GetPackageVersions(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindCpmFile_WalksUpToTheNearestPropsFile()
    {
        // Arrange
        using var workspace = new TemporaryDirectory("cpm-walk");
        var propsPath = workspace.WriteFile("Directory.Packages.props", SingleGroup);
        var projectPath = workspace.WriteFile(
            Path.Combine("src", "App", "App.csproj"),
            "<Project Sdk=\"Microsoft.NET.Sdk\" />");

        // Act
        var found = CpmPropsReader.FindCpmFile(projectPath);

        // Assert
        Assert.AreEqual(propsPath, found);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void IsEnabled_ProjectOptOut_DisablesCpm()
    {
        // Arrange
        using var workspace = new TemporaryDirectory("cpm-optout");
        var propsPath = workspace.WriteFile("Directory.Packages.props", SingleGroup);
        var projectPath = workspace.WriteFile("App.csproj", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <ManagePackageVersionsCentrally>false</ManagePackageVersionsCentrally>
              </PropertyGroup>
            </Project>
            """);

        // Act + Assert
        Assert.IsFalse(CpmPropsReader.IsEnabled(projectPath, propsPath));
    }
}
