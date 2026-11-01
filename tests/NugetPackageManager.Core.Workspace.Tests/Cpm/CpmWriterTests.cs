// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmWriterTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Every expected file in tests/NugetPackageManager.TestUtilities/Fixtures/cpm/expected was produced by the TypeScript
// `UpdateCpmVersionsAsync` / `RemovePackageVersionAsync` before the port. The comparison is
// byte for byte on purpose: the writer edits text surgically so the user's formatting survives,
// and a reformat would be a visible regression.

using NugetPackageManager.Core.Workspace.Cpm;
using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.TestUtilities;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the workspace.")]
public class CpmWriterTests
{
    private const string PropsFileWithProperty = """
        <Project>
          <PropertyGroup>
            <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
            <FooBarVersion>1.2.3</FooBarVersion>
          </PropertyGroup>
          <ItemGroup>
            <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
          </ItemGroup>
        </Project>
        """;

    private TemporaryDirectory? workspace;
    private string propsPath = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("cpm-writer");
        propsPath = workspace.Combine("Directory.Packages.props");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_FirstScope_MatchesTheGoldenFile()
    {
        await AssertGoldenAsync(
            "single-group.props",
            [new CpmVersionChange("Newtonsoft.Json", "13.0.4")],
            "single-group.first.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_GroupScope_TouchesOnlyThatItemGroup()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "1.5.0", "$(TargetFramework.StartsWith('net10.0'))", CpmWriteScope.Group)],
            "unconditional-plus-conditional.group.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_UnconditionalScope_LeavesFrameworkLinesAlone()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "3.0.0", Condition: null, Scope: CpmWriteScope.Unconditional)],
            "unconditional-plus-conditional.unconditional.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_AllScope_RewritesEveryOccurrence()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "9.9.9", Condition: null, Scope: CpmWriteScope.All)],
            "unconditional-plus-conditional.all.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_NegatedCondition_MatchesByCombinedCondition()
    {
        await AssertGoldenAsync(
            "negated-positive.props",
            [new CpmVersionChange("Microsoft.Extensions.Logging", "11.0.0-rc.3", "$(TargetFramework.StartsWith('net11.0'))", CpmWriteScope.Group)],
            "negated-positive.group.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RemovePackageVersionAsync_RemovesOnlyThatPackage()
    {
        var before = CopyFixture("unconditional-plus-conditional.props");

        var removed = await CpmWriter.RemovePackageVersionAsync(propsPath, "Pkg.UnconditionalOnly");

        Assert.IsTrue(removed);
        var expected = File.ReadAllText(GoldenPath("unconditional-plus-conditional.removed.props"));
        Assert.AreEqual(expected, File.ReadAllText(propsPath));
        Assert.AreNotEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RemovePackageVersionAsync_PackageAbsent_ReturnsFalseAndLeavesTheFile()
    {
        var before = CopyFixture("single-group.props");

        var removed = await CpmWriter.RemovePackageVersionAsync(propsPath, "Not.There");

        Assert.IsFalse(removed);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_UnknownCondition_FailsAndLeavesTheFile()
    {
        var before = CopyFixture("unconditional-plus-conditional.props");

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath,
                [new CpmVersionChange("Pkg.Shared", "1.5.0", "$(TargetFramework.StartsWith('net99.0'))", CpmWriteScope.Group)]));

        Assert.AreEqual("packageNotFound", error.Code);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_InvalidPackageIdOrVersion_IsRefused()
    {
        var before = CopyFixture("single-group.props");

        var badId = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath, [new CpmVersionChange("bad id", "1.0.0")]));
        var badVersion = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath, [new CpmVersionChange("Newtonsoft.Json", "not-a-version")]));

        Assert.AreEqual("invalidPackageId", badId.Code);
        Assert.AreEqual("invalidVersion", badVersion.Code);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_AppliesEveryChangeInOneWrite()
    {
        CopyFixture("single-group.props");

        await CpmWriter.UpdateVersionsAsync(propsPath, [
            new CpmVersionChange("Newtonsoft.Json", "13.0.4"),
            new CpmVersionChange("Serilog", "2.12.0"),
        ]);

        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "Include=\"Newtonsoft.Json\" Version=\"13.0.4\"");
        StringAssert.Contains(content, "Include=\"Serilog\" Version=\"2.12.0\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_PropertyInThePropsFile_RewritesThePropertyNotTheReference()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();

        // Act
        var written = await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [workspace!.Root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(propsPath, "FooBarVersion", "1.2.3")));

        // Assert
        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "<FooBarVersion>1.4.0</FooBarVersion>");
        StringAssert.Contains(content, "Include=\"Foo.Bar\" Version=\"$(FooBarVersion)\"");
        Assert.AreEqual(1, written.Count);
        Assert.AreEqual(propsPath, written[0]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_PropertyInDirectoryBuildProps_RewritesThatFileOnly()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();
        var buildPropsPath = workspace!.WriteFile("Directory.Build.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var propsBefore = File.ReadAllText(propsPath);
        var buildPropsBefore = File.ReadAllText(buildPropsPath);

        // Act
        var written = await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [workspace.Root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(buildPropsPath, "FooBarVersion", "1.2.3")));

        // Assert
        Assert.AreEqual(propsBefore, File.ReadAllText(propsPath));
        Assert.AreNotEqual(buildPropsBefore, File.ReadAllText(buildPropsPath));
        StringAssert.Contains(File.ReadAllText(buildPropsPath), "<FooBarVersion>1.4.0</FooBarVersion>");
        Assert.AreEqual(1, written.Count);
        Assert.AreEqual(buildPropsPath, written[0]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_SharedProperty_MovesEveryPackageUsingIt()
    {
        // Arrange
        WriteProps("""
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <SharedVersion>1.2.3</SharedVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(SharedVersion)" />
                <PackageVersion Include="Foo.Baz" Version="$(SharedVersion)" />
              </ItemGroup>
            </Project>
            """);
        var projectPath = WriteProject();

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "2.0.0")],
            default,
            [projectPath],
            [workspace!.Root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(propsPath, "SharedVersion", "1.2.3")));

        // Assert — one bump moves both packages, because both still read the property.
        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "<SharedVersion>2.0.0</SharedVersion>");
        StringAssert.Contains(content, "Include=\"Foo.Bar\" Version=\"$(SharedVersion)\"");
        StringAssert.Contains(content, "Include=\"Foo.Baz\" Version=\"$(SharedVersion)\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_GroupScopedUpdate_WritesALiteralAndLeavesThePropertyAlone()
    {
        // Arrange — the per-TFM guard: bumping the property would move every framework.
        WriteProps("""
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var projectPath = WriteProject();
        var locator = new FakePropertyLocator().Map(
            projectPath, new PropertyDefinition(propsPath, "FooBarVersion", "1.2.3"));

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.5.0", "'$(TargetFramework)' == 'net10.0'", CpmWriteScope.Group)],
            default,
            [projectPath],
            [workspace!.Root],
            locator);

        // Assert
        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "<FooBarVersion>1.2.3</FooBarVersion>");
        StringAssert.Contains(content, "Include=\"Foo.Bar\" Version=\"1.5.0\"");
        Assert.AreEqual(0, locator.Calls);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_PropertyFileOutsideTheWorkspaceRoots_WritesALiteral()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();
        var root = workspace!.CreateDirectory("inside");
        var outsidePath = workspace.WriteFile("outside/Directory.Build.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var outsideBefore = File.ReadAllText(outsidePath);

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(outsidePath, "FooBarVersion", "1.2.3")));

        // Assert — containment is a security guard: the file outside the root is never edited.
        Assert.AreEqual(outsideBefore, File.ReadAllText(outsidePath));
        StringAssert.Contains(File.ReadAllText(propsPath), "Include=\"Foo.Bar\" Version=\"1.4.0\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_ProjectsDisagreeingOnTheDefinition_WriteALiteral()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var firstProject = WriteProject("App");
        var secondProject = WriteProject("Lib");
        var firstFile = workspace!.WriteFile("a/Directory.Build.props", PropertyFile("1.2.3"));
        var secondFile = workspace.WriteFile("b/Directory.Build.props", PropertyFile("1.2.3"));
        var locator = new FakePropertyLocator()
            .Map(firstProject, new PropertyDefinition(firstFile, "FooBarVersion", "1.2.3"))
            .Map(secondProject, new PropertyDefinition(secondFile, "FooBarVersion", "1.2.3"));

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [firstProject, secondProject],
            [workspace.Root],
            locator);

        // Assert
        Assert.AreEqual(PropertyFile("1.2.3"), File.ReadAllText(firstFile));
        Assert.AreEqual(PropertyFile("1.2.3"), File.ReadAllText(secondFile));
        StringAssert.Contains(File.ReadAllText(propsPath), "Include=\"Foo.Bar\" Version=\"1.4.0\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_EmbeddedExpression_WritesALiteral()
    {
        // Arrange — `1.$(Minor)` is not a whole-value reference.
        WriteProps("""
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <Minor>2.3</Minor>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="1.$(Minor)" />
              </ItemGroup>
            </Project>
            """);
        var projectPath = WriteProject();
        var locator = new FakePropertyLocator().Map(
            projectPath, new PropertyDefinition(propsPath, "Minor", "2.3"));

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [workspace!.Root],
            locator);

        // Assert
        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "<Minor>2.3</Minor>");
        StringAssert.Contains(content, "Include=\"Foo.Bar\" Version=\"1.4.0\"");
        Assert.AreEqual(0, locator.Calls);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_UnresolvableProperty_WritesALiteral()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();
        var locator = new FakePropertyLocator();

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [workspace!.Root],
            locator);

        // Assert
        StringAssert.Contains(File.ReadAllText(propsPath), "Include=\"Foo.Bar\" Version=\"1.4.0\"");
        Assert.AreEqual(1, locator.Calls);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_PropertyEdit_KeepsTheFileFormatting()
    {
        // Arrange — a comment, an unrelated property, a labelled group and padded whitespace.
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();
        var buildPropsPath = workspace!.WriteFile("Directory.Build.props", """
            <Project>
              <!-- Keep this comment. -->
              <PropertyGroup Label="Versions">
                <FooBarVersion>  1.2.3  </FooBarVersion>
                <OtherVersion>9.9.9</OtherVersion>
              </PropertyGroup>
            </Project>
            """);

        // Act
        await CpmWriter.UpdateVersionsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            default,
            [projectPath],
            [workspace.Root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(buildPropsPath, "FooBarVersion", "1.2.3")));

        // Assert
        Assert.AreEqual(
            """
            <Project>
              <!-- Keep this comment. -->
              <PropertyGroup Label="Versions">
                <FooBarVersion>  1.4.0  </FooBarVersion>
                <OtherVersion>9.9.9</OtherVersion>
              </PropertyGroup>
            </Project>
            """,
            File.ReadAllText(buildPropsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveWriteTargetsAsync_PropertyPath_ReturnsTheDefiningFileOnly()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var projectPath = WriteProject();
        var buildPropsPath = workspace!.WriteFile("Directory.Build.props", PropertyFile("1.2.3"));
        var propsBefore = File.ReadAllText(propsPath);
        var buildPropsBefore = File.ReadAllText(buildPropsPath);

        // Act
        var targets = await CpmWriter.ResolveWriteTargetsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            [projectPath],
            [workspace.Root],
            new FakePropertyLocator().Map(projectPath, new PropertyDefinition(buildPropsPath, "FooBarVersion", "1.2.3")));

        // Assert — read-only: nothing on disk changed.
        Assert.AreEqual(1, targets.Count);
        Assert.AreEqual(buildPropsPath, targets[0]);
        Assert.AreEqual(propsBefore, File.ReadAllText(propsPath));
        Assert.AreEqual(buildPropsBefore, File.ReadAllText(buildPropsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveWriteTargetsAsync_LiteralPath_ReturnsThePropsFile()
    {
        // Arrange
        WriteProps(PropsFileWithProperty);
        var before = File.ReadAllText(propsPath);

        // Act
        var targets = await CpmWriter.ResolveWriteTargetsAsync(
            propsPath,
            [new CpmVersionChange("Foo.Bar", "1.4.0")],
            [WriteProject()],
            [workspace!.Root]);

        // Assert
        Assert.AreEqual(1, targets.Count);
        Assert.AreEqual(propsPath, targets[0]);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    private static string PropertyFile(string version) => $"""
        <Project>
          <PropertyGroup>
            <FooBarVersion>{version}</FooBarVersion>
          </PropertyGroup>
        </Project>
        """;

    private string WriteProps(string content)
    {
        File.WriteAllText(propsPath, content);
        return propsPath;
    }

    private string WriteProject(string name = "App") =>
        workspace!.WriteFile($"{name}/{name}.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");

    private async Task AssertGoldenAsync(string fixture, IReadOnlyList<CpmVersionChange> changes, string golden)
    {
        CopyFixture(fixture);

        await CpmWriter.UpdateVersionsAsync(propsPath, changes);

        Assert.AreEqual(File.ReadAllText(GoldenPath(golden)), File.ReadAllText(propsPath));
    }

    private string CopyFixture(string fixture)
    {
        var content = TestPaths.ReadFixture("cpm", fixture);
        File.WriteAllText(propsPath, content);
        return content;
    }

    private static string GoldenPath(string name) => TestPaths.Fixture("cpm", "expected", name);

    /// <summary>Answers every lookup from a fixed map, and counts the calls.</summary>
    private sealed class FakePropertyLocator : ICpmPropertyLocator
    {
        private readonly Dictionary<string, PropertyDefinition?> definitions = [];

        public int Calls { get; private set; }

        public FakePropertyLocator Map(string projectPath, PropertyDefinition? definition)
        {
            definitions[projectPath] = definition;
            return this;
        }

        public Task<PropertyDefinition?> LocateAsync(
            string projectPath,
            string propertyName,
            CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(definitions.TryGetValue(projectPath, out var definition) ? definition : null);
        }
    }
}
