// File: tests/NugetPackageManager.Core.Workspace.Tests/Projects/ProjectFileReaderTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors the behaviour of `project-parser.ts`: attribute or child version, VersionOverride
// wins, CPM beats the project value, and `[1.0]` is pinned.

using NugetPackageManager.Core.Workspace.Projects;

namespace NugetPackageManager.Core.Workspace.Tests.Projects;

[TestClass]
public class ProjectFileReaderTests
{
    private static readonly string[] expectedPackages = ["Microsoft.Extensions.Logging", "Shared.Library"];

    private string directory = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        directory = Path.Combine(Path.GetTempPath(), "nugget-core-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
    }

    [TestCleanup]
    public void Cleanup()
    {
        if (Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }
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
        var fixture = Path.Combine(
            FindRepositoryRoot(),
            "tests",
            "__fixtures__",
            "projects",
            "net10",
            "net10.csproj");

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

    private static string FindRepositoryRoot()
    {
        var directory = AppContext.BaseDirectory;

        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory, "package.json")))
            {
                return directory;
            }

            directory = Path.GetDirectoryName(directory);
        }

        throw new InvalidOperationException("repository root not found");
    }

    private string WriteProject(string content)
    {
        var path = Path.Combine(directory, "Sample.csproj");
        File.WriteAllText(path, content);
        return path;
    }
}
