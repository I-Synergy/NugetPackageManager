// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmPropertyLocatorTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Exercises the preprocessed-output parser without spawning `dotnet msbuild`: the fixture is a
// hand-written copy of the shape `-pp` produces, with the import boundary comments, a nested
// import, a conditional definition and a target-scoped definition.

using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
public class CpmPropertyLocatorTests
{
    private const string ProjectPath = @"C:\repo\src\App\App.csproj";
    private const string DirectoryBuildPropsPath = @"C:\repo\src\Directory.Build.props";
    private const string ImportedVersionsPath = @"C:\repo\src\build\versions.props";

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_LastUnconditionalDefinition_Wins()
    {
        // Arrange — 1.2.3 is unconditional, 2.0.0 follows it in the nested import, and the last
        // two definitions (9.9.9 conditional, 7.7.7 inside a target) are not editable.
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "FooBarVersion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual(ImportedVersionsPath, definition.FilePath);
        Assert.AreEqual("FooBarVersion", definition.PropertyName);
        Assert.AreEqual("2.0.0", definition.Value);
        Assert.AreNotEqual("9.9.9", definition.Value);
        Assert.AreNotEqual("7.7.7", definition.Value);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_NestedImport_IsAttributedToTheImportedFile()
    {
        // Arrange
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "NestedOnlyVersion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual(ImportedVersionsPath, definition.FilePath);
        Assert.AreEqual("3.0.0", definition.Value);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_DefinitionAfterTheNestedImport_ReturnsToTheOuterFile()
    {
        // Arrange — closing the nested import must pop back to Directory.Build.props.
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "OtherVersion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual(DirectoryBuildPropsPath, definition.FilePath);
        Assert.AreEqual("4.0.0", definition.Value);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_DefinitionOutsideAnyImport_IsTheProject()
    {
        // Arrange
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "ProjectLevelVersion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual(ProjectPath, definition.FilePath);
        Assert.AreEqual("5.0.0", definition.Value);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_CommentedOutImport_DoesNotChangeAttribution()
    {
        // Arrange — `-pp` writes a false import as a single commented-out element.
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "CommentedImportScopeVersion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual(DirectoryBuildPropsPath, definition.FilePath);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_TargetScopedDefinitionOnly_IsNull()
    {
        // Arrange
        var xml = ReadPreprocessed();

        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(xml, ProjectPath, "TargetOnlyVersion");

        // Assert
        Assert.IsNull(definition);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_UnknownProperty_IsNull()
    {
        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(ReadPreprocessed(), ProjectPath, "NotDefinedAnywhere");

        // Assert
        Assert.IsNull(definition);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_PropertyNameLookup_IsCaseInsensitive()
    {
        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed(ReadPreprocessed(), ProjectPath, "foobarversion");

        // Assert
        Assert.IsNotNull(definition);
        Assert.AreEqual("FooBarVersion", definition.PropertyName);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParsePreprocessed_InvalidXml_IsNull()
    {
        // Act
        var definition = CpmPropertyLocator.ParsePreprocessed("<Project><PropertyGroup>", ProjectPath, "FooBarVersion");

        // Assert
        Assert.IsNull(definition);
    }

    private static string ReadPreprocessed() => TestPaths.ReadFixture("msbuild", "preprocessed-project.xml");
}
