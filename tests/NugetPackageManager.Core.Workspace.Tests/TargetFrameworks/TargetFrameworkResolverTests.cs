// File: tests/NugetPackageManager.Core.Workspace.Tests/TargetFrameworks/TargetFrameworkResolverTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors the precedence of `project-framework-resolver.ts`: literal XML, then the restore
// record, then `dotnet msbuild`, then a literal XML fallback.

using NugetPackageManager.Core.Workspace.TargetFrameworks;

namespace NugetPackageManager.Core.Workspace.Tests.TargetFrameworks;

[TestClass]
public class TargetFrameworkResolverTests
{
    private static readonly string[] net10AndNet11 = ["net10.0", "net11.0"];
    private static readonly string[] net11Only = ["net11.0"];

    private string directory = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        directory = Path.Combine(Path.GetTempPath(), "tfm-tests", Guid.NewGuid().ToString("N"));
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
    public void ParseFrameworks_ReadsBothProperties()
    {
        // Arrange
        const string output = """
              TargetFrameworks = net10.0;net11.0
              TargetFramework = net10.0
            """;

        // Act
        var frameworks = TargetFrameworkResolver.ParseFrameworks(output);

        // Assert
        CollectionAssert.AreEqual(
            net10AndNet11,
            frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseFrameworks_EmptyOutput_IsEmpty()
    {
        Assert.AreEqual(0, TargetFrameworkResolver.ParseFrameworks(string.Empty).Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditionalFrameworks_LiteralDeclaration_IsUsed()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        // Act
        var info = TargetFrameworkResolver.TryParseUnconditionalFrameworks(project);

        // Assert
        Assert.IsNotNull(info);
        Assert.AreEqual(TargetFrameworkSource.Xml, info.Source);
        CollectionAssert.AreEqual(net10AndNet11, info.Frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditionalFrameworks_ConditionalDeclaration_FallsThrough()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup Condition="'$(Configuration)' == 'Release'">
                <TargetFrameworks>net10.0</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        // Act + Assert — a condition can change the effective list, so this is not the fast path.
        Assert.IsNull(TargetFrameworkResolver.TryParseUnconditionalFrameworks(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryParseUnconditionalFrameworks_PropertyExpression_FallsThrough()
    {
        // Arrange
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>$(SomeFramework)</TargetFrameworks>
              </PropertyGroup>
            </Project>
            """);

        // Act + Assert
        Assert.IsNull(TargetFrameworkResolver.TryParseUnconditionalFrameworks(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolveFromAssets_NewerAssetsFile_IsUsed()
    {
        // Arrange
        var project = WriteProject("<Project Sdk=\"Microsoft.NET.Sdk\" />");
        WriteAssets("""{"targets":{"net10.0":{},"net11.0":{}}}""", DateTime.UtcNow.AddMinutes(1));

        // Act
        var info = TargetFrameworkResolver.TryResolveFromAssets(project);

        // Assert
        Assert.IsNotNull(info);
        Assert.AreEqual(TargetFrameworkSource.Assets, info.Source);
        CollectionAssert.AreEquivalent(net10AndNet11, info.Frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolveFromAssets_StaleAssetsFile_IsIgnored()
    {
        // Arrange — assets older than the project cannot be trusted.
        var project = WriteProject("<Project Sdk=\"Microsoft.NET.Sdk\" />");
        WriteAssets("""{"targets":{"net10.0":{}}}""", DateTime.UtcNow.AddMinutes(-5));

        // Act + Assert
        Assert.IsNull(TargetFrameworkResolver.TryResolveFromAssets(project));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetTargetFrameworksAsync_MissingProject_ReturnsOverrides()
    {
        // Arrange
        using var resolver = new TargetFrameworkResolver();
        var missing = Path.Combine(directory, "Missing.csproj");

        // Act
        var info = await resolver.GetTargetFrameworksAsync(missing, ["net11.0"], CancellationToken.None);

        // Assert
        Assert.AreEqual(TargetFrameworkSource.Override, info.Source);
        CollectionAssert.AreEqual(net11Only, info.Frameworks.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetTargetFrameworksAsync_LiteralProject_AppendsOverrides()
    {
        // Arrange
        using var resolver = new TargetFrameworkResolver();
        var project = WriteProject("""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);

        // Act
        var info = await resolver.GetTargetFrameworksAsync(project, ["net11.0"], CancellationToken.None);

        // Assert — no `dotnet msbuild` process is spent here.
        Assert.AreEqual(TargetFrameworkSource.Xml, info.Source);
        CollectionAssert.AreEqual(net10AndNet11, info.Frameworks.ToArray());
    }

    private string WriteProject(string content)
    {
        var path = Path.Combine(directory, "Sample.csproj");
        File.WriteAllText(path, content);
        return path;
    }

    private void WriteAssets(string content, DateTime modifiedUtc)
    {
        var objDirectory = Path.Combine(directory, "obj");
        Directory.CreateDirectory(objDirectory);
        var path = Path.Combine(objDirectory, "project.assets.json");
        File.WriteAllText(path, content);
        File.SetLastWriteTimeUtc(path, modifiedUtc);
    }
}
