// File: tests/NugetPackageManager.Core.Workspace.Tests/WorkspaceModelServiceTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `parseProjectWithCpmAsync` in host-api.ts: CPM lookup, flat version map, conditional
// resolutions and the `CpmEnabled` / `TargetFrameworks` / `TfmSource` fields.

using NugetPackageManager.Core.Workspace.Cpm;
using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the workspace.")]
public class WorkspaceModelServiceTests
{
    private static readonly string[] net10Only = ["net10.0"];
    private static readonly string[] net10AndNet11 = ["net10.0", "net11.0"];

    private TemporaryDirectory? workspace;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("workspace-model");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ProjectsWithoutCpm_AreParsedAndSorted()
    {
        // Arrange
        var beta = WriteProject("Beta", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Serilog" Version="3.1.1" />
              </ItemGroup>
            </Project>
            """);
        var alpha = WriteProject("Alpha", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([beta, alpha], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(2, projects.Count);
        Assert.AreEqual("Alpha.csproj", projects[0].Name);
        Assert.AreEqual("Beta.csproj", projects[1].Name);
        Assert.IsFalse(projects[0].CpmEnabled);
        Assert.AreEqual("13.0.3", projects[0].Packages[0].Version);
        Assert.AreEqual("project", projects[0].Packages[0].VersionSource);
        Assert.AreEqual("xml", projects[0].TfmSource);
        Assert.AreEqual(0, projects[0].TargetFrameworks?.Count ?? 0);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CentralPackages_ResolvesVersionsAndFlag()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Central", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var parsed = projects[0];
        Assert.IsTrue(parsed.CpmEnabled);
        Assert.AreEqual("13.0.3", parsed.Packages[0].Version);
        Assert.AreEqual("central", parsed.Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ConditionalCpm_ProducesResolutionsPerFramework()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
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
            """);
        var project = WriteProject("Multi", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var package = projects[0].Packages[0];
        Assert.IsNotNull(package.CpmResolutions);
        Assert.AreEqual(2, package.CpmResolutions.Count);
        Assert.AreEqual("10.0.1", package.CpmResolutions[0].Version);
        Assert.AreEqual("net10.0", package.CpmResolutions[0].Tfm);
        Assert.AreEqual("11.0.0", package.CpmResolutions[1].Version);
        Assert.AreEqual("net10.0", package.CpmFramework);
        // Two version lines disagree, so `Version` keeps the flat CPM value (first conditional
        // occurrence) instead of being collapsed to one of them — same as the TypeScript path.
        Assert.AreEqual("10.0.1", package.Version);
        Assert.AreEqual("net10.0;net11.0", string.Join(';', projects[0].TargetFrameworks!));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ConditionMatchesSingleVersion_FillsVersion()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup Condition="$(TargetFramework.StartsWith('net1'))">
                <PackageVersion Include="Pkg.Shared" Version="9.9.9" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Single", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(1, projects[0].Packages[0].CpmResolutions!.Count);
        Assert.AreEqual("9.9.9", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void BuildFlatMap_UnconditionalWinsOverConditional()
    {
        // Arrange
        var unconditional = new Dictionary<string, string> { ["A"] = "1.0.0" };
        var conditional = new List<CpmFrameworkEntry>
        {
            new()
            {
                Condition = "$(TargetFramework) == 'net10.0'",
                Framework = "net10.0",
                Versions = new Dictionary<string, string> { ["A"] = "2.0.0", ["B"] = "3.0.0" },
                Order = 1,
            },
        };
        var map = new CpmPackageMap(unconditional, conditional, true);

        // Act
        var flat = WorkspaceModelService.BuildFlatMap(map);

        // Assert
        Assert.AreEqual("1.0.0", flat["A"]);
        Assert.AreEqual("3.0.0", flat["B"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_UnreadableProject_IsSkipped()
    {
        // Arrange
        var broken = workspace!.Combine("Broken.csproj");
        File.WriteAllText(broken, "<Project><unclosed>");

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([broken], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(0, projects.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CpmFixtures_MatchTheKnownFrameworkLines()
    {
        // The fixtures the TypeScript suite used to assert against, now checked where the
        // resolution logic lives.
        File.Copy(
            TestPaths.Fixture("cpm", "negated-positive.props"),
            workspace!.Combine("Directory.Packages.props"));

        var projects = new List<string>();
        foreach (var fixture in new[] { "net10", "net11", "multi", "net10-windows" })
        {
            var target = workspace!.Combine($"{fixture}.csproj");
            File.Copy(TestPaths.Fixture("projects", fixture, $"{fixture}.csproj"), target);
            projects.Add(target);
        }

        using var service = new WorkspaceModelService();

        // Act
        var models = await service.GetProjectsAsync(projects, [], CancellationToken.None);

        // Assert
        var byName = models.ToDictionary(project => project.Name, StringComparer.OrdinalIgnoreCase);

        var net10 = byName["net10.csproj"];
        CollectionAssert.AreEqual(net10Only, net10.TargetFrameworks!.ToArray());
        var loggingNet10 = net10.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual(1, loggingNet10.CpmResolutions!.Count);
        Assert.AreEqual("net10.0", loggingNet10.CpmResolutions[0].Tfm);
        Assert.AreEqual("10.0.13", loggingNet10.CpmResolutions[0].Version);
        Assert.AreEqual("not net11.0", loggingNet10.CpmResolutions[0].ConditionLabel);
        Assert.AreEqual("not net11.0", loggingNet10.CpmFramework);

        var net11 = byName["net11.csproj"];
        var loggingNet11 = net11.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual("net11.0", loggingNet11.CpmResolutions![0].Tfm);
        Assert.AreEqual("11.0.0-rc.2.26504.105", loggingNet11.CpmResolutions[0].Version);

        var multi = byName["multi.csproj"];
        CollectionAssert.AreEqual(net10AndNet11, multi.TargetFrameworks!.ToArray());
        var loggingMulti = multi.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual(2, loggingMulti.CpmResolutions!.Count);
        Assert.AreEqual("10.0.13", loggingMulti.CpmResolutions.Single(r => r.Tfm == "net10.0").Version);
        Assert.AreEqual("11.0.0-rc.2.26504.105", loggingMulti.CpmResolutions.Single(r => r.Tfm == "net11.0").Version);

        var windows = byName["net10-windows.csproj"];
        var loggingWindows = windows.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual("net10.0-windows10.0.26100.0", loggingWindows.CpmResolutions![0].Tfm);
        Assert.AreEqual("10.0.13", loggingWindows.CpmResolutions[0].Version);

        var shared = multi.Packages.Single(package => package.Id == "Shared.Library");
        Assert.AreEqual(1, shared.CpmResolutions!.Count);
        Assert.AreEqual(string.Empty, shared.CpmResolutions[0].Tfm);
        Assert.AreEqual("1.0.0", shared.CpmResolutions[0].Version);
    }

    private string WriteProject(string name, string content) =>
        workspace!.WriteFile($"{name}.csproj", content);
}
