// File: tests/NugetPackageManager.Core.Workspace.Tests/TargetFrameworks/TargetFrameworkResolverFallbackTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The resolver tries four sources in order: literal XML, the restore record, `dotnet msbuild`,
// then a literal parse of the file. The happy paths are in TargetFrameworkResolverTests; this
// pins the fall-throughs, which is what decides which source wins when a project is unusual.

using NugetPackageManager.Core.Workspace.TargetFrameworks;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Tests.TargetFrameworks;

[TestClass]
public class TargetFrameworkResolverFallbackTests
{
    private static readonly string[] expectedDual = ["net8.0", "net9.0"];
    // Normalize keeps document order and drops duplicates.
    private static readonly string[] expectedMultiDeclaration = ["net9.0", "net8.0"];
    private static readonly string[] expectedSingle = ["net10.0"];

    private string directory = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        directory = Path.Combine(Path.GetTempPath(), "tfm-fallback", Guid.NewGuid().ToString("N"));
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

    private string WriteProject(string content, string name = "App.csproj")
    {
        var path = Path.Combine(directory, name);
        File.WriteAllText(path, content);
        return path;
    }

    private string WriteAssets(string content)
    {
        var obj = Path.Combine(directory, "obj");
        Directory.CreateDirectory(obj);
        var path = Path.Combine(obj, "project.assets.json");
        File.WriteAllText(path, content);
        // The assets file has to be newer than the project, or it counts as stale.
        File.SetLastWriteTimeUtc(path, DateTime.UtcNow.AddMinutes(1));
        return path;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditional_WithoutADeclaration_IsNull()
    {
        var project = WriteProject("<Project><PropertyGroup /></Project>");

        Assert.IsNull(TargetFrameworkResolver.TryParseUnconditionalFrameworks(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditional_WithTwoDeclarations_IsNull()
    {
        var project = WriteProject("""
            <Project>
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
                <TargetFrameworks>net8.0;net9.0</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        Assert.IsNull(TargetFrameworkResolver.TryParseUnconditionalFrameworks(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditional_WithBrokenXml_IsNull()
    {
        var project = WriteProject("<Project><PropertyGroup><TargetFramework>net8.0</TargetFrameworks></Project>");

        Assert.IsNull(TargetFrameworkResolver.TryParseUnconditionalFrameworks(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolveFromAssets_WithoutAnAssetsFile_IsNull()
    {
        var project = WriteProject("<Project />");

        Assert.IsNull(TargetFrameworkResolver.TryResolveFromAssets(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolveFromAssets_WithoutTargets_IsNull()
    {
        var project = WriteProject("<Project />");
        WriteAssets("""{"version": 3}""");

        Assert.IsNull(TargetFrameworkResolver.TryResolveFromAssets(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolveFromAssets_WithBrokenJson_IsNull()
    {
        var project = WriteProject("<Project />");
        WriteAssets("{ not json");

        Assert.IsNull(TargetFrameworkResolver.TryResolveFromAssets(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseProjectFile_ReadsTheMultiTargetDeclaration()
    {
        var project = WriteProject("""
            <Project>
              <PropertyGroup>
                <TargetFrameworks>net9.0; net8.0 ;net9.0</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        var info = TargetFrameworkResolver.ParseProjectFile(project);

        CollectionAssert.AreEqual(expectedMultiDeclaration, info.Frameworks.ToArray());
        Assert.AreEqual(TargetFrameworkSource.Xml, info.Source);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseProjectFile_ReadsTheSingleTargetDeclaration()
    {
        var project = WriteProject("""
            <Project>
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);

        var info = TargetFrameworkResolver.ParseProjectFile(project);

        CollectionAssert.AreEqual(expectedSingle, info.Frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseProjectFile_IgnoresPropertyExpressions()
    {
        var project = WriteProject("""
            <Project>
              <PropertyGroup>
                <TargetFrameworks>$(SomeVariable)</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        var info = TargetFrameworkResolver.ParseProjectFile(project);

        Assert.AreEqual(0, info.Frameworks.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseProjectFile_WithBrokenXml_IsEmpty()
    {
        var project = WriteProject("<Project><TargetFrameworks>net8.0</Project>");

        var info = TargetFrameworkResolver.ParseProjectFile(project);

        Assert.AreEqual(0, info.Frameworks.Count);
    }

    [TestMethod]
    [TestCategory("Integration")]
    public async Task EvaluateWithMsBuildAsync_ReturnsTheDeclaredFrameworks()
    {
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net8.0;net9.0</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        using var resolver = new TargetFrameworkResolver();
        var frameworks = await resolver.EvaluateWithMsBuildAsync(project, CancellationToken.None);

        CollectionAssert.AreEquivalent(expectedDual, frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Dispose_CanBeCalledTwice()
    {
        var resolver = new TargetFrameworkResolver();

        resolver.Dispose();
        resolver.Dispose();
    }
}
