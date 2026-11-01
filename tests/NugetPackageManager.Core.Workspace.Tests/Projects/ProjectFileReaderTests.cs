// File: tests/NugetPackageManager.Core.Workspace.Tests/Projects/ProjectFileReaderTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors the behaviour of `project-parser.ts`: attribute or child version, VersionOverride
// wins, CPM beats the project value, and `[1.0]` is pinned.

using NugetPackageManager.Core.Workspace.Projects;
using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Projects;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the workspace.")]
public class ProjectFileReaderTests
{
    private static readonly string[] expectedPackages = ["Microsoft.Extensions.Logging", "Shared.Library"];

    private TemporaryDirectory? workspace;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("nugget-core-tests");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_SdkStyleProject_ReadsAttributeVersion()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);

        // Act
        var model = ProjectFileReader.Read(project);

        // Assert
        Assert.AreEqual("Sample.csproj", model.Name);
        Assert.AreEqual(project, model.Path);
        Assert.IsFalse(model.CpmEnabled);
        Assert.AreEqual(1, model.Packages.Count);
        Assert.AreEqual("Newtonsoft.Json", model.Packages[0].Id);
        Assert.AreEqual("13.0.3", model.Packages[0].Version);
        Assert.AreEqual("project", model.Packages[0].VersionSource);
        Assert.IsFalse(model.Packages[0].IsPinned);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_NamespacedProject_ReadsChildVersionElement()
    {
        // Arrange
        var project = WriteProject("""
            <Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
              <ItemGroup>
                <PackageReference Include="Serilog">
                  <Version>3.1.1</Version>
                </PackageReference>
              </ItemGroup>
            </Project>
            """);

        // Act
        var model = ProjectFileReader.Read(project);

        // Assert
        Assert.AreEqual(1, model.Packages.Count);
        Assert.AreEqual("3.1.1", model.Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_CentralVersion_WinsOverProjectVersion()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" Version="12.0.1" />
              </ItemGroup>
            </Project>
            """);
        var cpm = new Dictionary<string, string> { ["Newtonsoft.Json"] = "13.0.3" };

        // Act
        var model = ProjectFileReader.Read(project, cpm);

        // Assert
        Assert.AreEqual("13.0.3", model.Packages[0].Version);
        Assert.AreEqual("central", model.Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_VersionOverride_BeatsCentralVersion()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" VersionOverride="12.0.1" />
              </ItemGroup>
            </Project>
            """);
        var cpm = new Dictionary<string, string> { ["Newtonsoft.Json"] = "13.0.3" };

        // Act
        var model = ProjectFileReader.Read(project, cpm);

        // Assert
        Assert.AreEqual("12.0.1", model.Packages[0].Version);
        Assert.AreEqual("override", model.Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_PackageMissingFromCpm_KeepsProjectVersion()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Local.Package" Version="1.2.3" />
              </ItemGroup>
            </Project>
            """);

        // Act
        var model = ProjectFileReader.Read(project, new Dictionary<string, string>());

        // Assert
        Assert.AreEqual("1.2.3", model.Packages[0].Version);
        Assert.AreEqual("project", model.Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_ExactRange_IsPinned()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Pinned" Version="[1.0.0]" />
                <PackageReference Include="Ranged" Version="[1.0.0, 2.0.0)" />
              </ItemGroup>
            </Project>
            """);

        // Act
        var model = ProjectFileReader.Read(project);

        // Assert
        Assert.IsTrue(model.Packages[0].IsPinned);
        Assert.IsFalse(model.Packages[1].IsPinned);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_ReferenceWithoutInclude_IsIgnored()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Version="1.0.0" />
                <PackageReference Include="Kept" Version="2.0.0" />
              </ItemGroup>
            </Project>
            """);

        // Act
        var model = ProjectFileReader.Read(project);

        // Assert
        Assert.AreEqual(1, model.Packages.Count);
        Assert.AreEqual("Kept", model.Packages[0].Id);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void IsPinnedVersion_EdgeCases()
    {
        Assert.IsTrue(ProjectFileReader.IsPinnedVersion("[1.0.0]"));
        Assert.IsFalse(ProjectFileReader.IsPinnedVersion("[1.0.0, 2.0.0)"));
        Assert.IsFalse(ProjectFileReader.IsPinnedVersion("1.0.0"));
        Assert.IsFalse(ProjectFileReader.IsPinnedVersion(null));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Read_RepositoryFixture_MatchesTheCheckedInProject()
    {
        // The MSBuild fixtures, parsed by the ported reader.
        var fixture = TestPaths.Fixture("projects", "net10", "net10.csproj");

        Assert.IsTrue(File.Exists(fixture), $"fixture not found: {fixture}");

        // Act
        var model = ProjectFileReader.Read(fixture);

        // Assert — the fixture declares `TargetFramework` plus two package references.
        Assert.AreEqual("net10.csproj", model.Name);
        Assert.AreEqual(2, model.Packages.Count);
        CollectionAssert.AreEquivalent(
            expectedPackages,
            model.Packages.Select(package => package.Id).ToArray());
    }

    private string WriteProject(string content) => workspace!.WriteFile("Sample.csproj", content);
}
