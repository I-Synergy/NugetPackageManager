// File: tests/NugetPackageManager.Core.Workspace.Tests/Tools/LocalToolManifestLocatorTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Manifest discovery: nested manifests, dedupe by real path, ignored folders, the workspace
// boundary and the walk-up from a project directory.

using NugetPackageManager.Core.Workspace.Tools;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Tools;

[TestClass]
public class LocalToolManifestLocatorTests
{
    private const string Manifest = "{\"version\":1,\"isRoot\":true,\"tools\":{}}";

    /// <summary>Hidden folders are internal by rule, whatever their name; each carries a manifest.</summary>
    private static readonly string[] hiddenFolderNames = [".scratch", ".ai", ".tmp"];

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_CollectsNestedManifestsFromOneRoot()
    {
        // Act
        var manifests = LocalToolManifestLocator.FindManifests([TestPaths.Fixture("tools", "nested")]);

        // Assert
        Assert.HasCount(2, manifests);
        Assert.IsTrue(manifests.Any(path => path.EndsWith(Path.Combine("reporting", ".config", "dotnet-tools.json"), StringComparison.Ordinal)));
        Assert.IsTrue(manifests.All(path => path.StartsWith(TestPaths.Fixture("tools", "nested"), StringComparison.Ordinal)));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_DeduplicatesOverlappingRoots()
    {
        // Arrange: the second root is inside the first, and the third spells the first differently.
        var root = TestPaths.Fixture("tools", "nested");

        // Act
        var manifests = LocalToolManifestLocator.FindManifests(
            [root, Path.Combine(root, "reporting"), Path.Combine(root, ".", "reporting", "..")]);

        // Assert
        Assert.HasCount(2, manifests);
        Assert.AreEqual(
            manifests.Count,
            manifests.Distinct(StringComparer.OrdinalIgnoreCase).Count());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_SkipsBuildAndPackageFolders()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var root = workspace.CreateDirectory("repo");

        foreach (var folder in new[] { "bin", "obj", "node_modules", ".git", ".vs", "src" })
        {
            WriteManifest(workspace, "repo", folder);
        }

        // Act
        var manifests = LocalToolManifestLocator.FindManifests([root]);

        // Assert
        Assert.HasCount(1, manifests);
        Assert.AreEqual(
            Path.Combine(root, "src", ".config", "dotnet-tools.json"),
            manifests[0]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_NeverLeavesTheWorkspaceRoot()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        WriteManifest(workspace, string.Empty);
        var root = workspace.CreateDirectory("inside");

        // Act
        var manifests = LocalToolManifestLocator.FindManifests([root]);

        // Assert
        Assert.IsEmpty(manifests);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_WalksUpFromAProjectInsideAnIgnoredFolder()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var root = workspace.CreateDirectory("repo");
        var manifest = WriteManifest(workspace, "repo", "bin");
        var project = Path.Combine(root, "bin", "App.csproj");
        File.WriteAllText(project, "<Project />");

        // Act: the walk skips `bin`, the project path walks back up to it.
        var manifests = LocalToolManifestLocator.FindManifests([root], [project]);

        // Assert
        Assert.HasCount(1, manifests);
        Assert.AreEqual(manifest, Path.GetFullPath(manifests[0]));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_IgnoresMissingRootsAndBlankEntries()
    {
        using var workspace = new TemporaryDirectory("local-tools");

        var manifests = LocalToolManifestLocator.FindManifests(
            [Path.Combine(workspace.Root, "missing"), "   "]);

        Assert.IsEmpty(manifests);
        Assert.IsEmpty(LocalToolManifestLocator.FindManifests([]));
        Assert.IsEmpty(LocalToolManifestLocator.FindManifests(null));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_KeepsTheWorkspaceThatOwnsEachManifest()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var outer = workspace.CreateDirectory("outer");
        var inner = workspace.CreateDirectory("outer", "inner");
        var outerManifest = WriteManifest(workspace, "outer");
        var innerManifest = WriteManifest(workspace, "outer", "inner");

        // Act
        var manifests = LocalToolManifestLocator.FindManifests([outer, inner]);

        // Assert
        CollectionAssert.AreEquivalent(
            new[] { outerManifest, innerManifest },
            manifests.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_IgnoresEveryManifestInsideAHiddenFolder()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var root = workspace.CreateDirectory("repo");
        var rootManifest = WriteManifest(workspace, "repo");
        var nestedManifest = WriteManifest(workspace, "repo", "src");

        // The cached checkout a catalog scan leaves behind: `repo/.ai` is internal as a whole.
        WriteManifest(workspace, "repo", ".ai", "tmp", "catalog-cache", "cached-repo");

        // Act
        var manifests = LocalToolManifestLocator.FindManifests([root]);

        // Assert: only the two manifests on the visible part of the tree are reported.
        CollectionAssert.AreEquivalent(
            new[] { rootManifest, nestedManifest },
            manifests.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_IgnoresHiddenFoldersOtherThanTheScratchFolder()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var root = workspace.CreateDirectory("repo");
        var rootManifest = WriteManifest(workspace, "repo");

        foreach (var hidden in hiddenFolderNames)
        {
            WriteManifest(workspace, "repo", hidden);
        }

        // Act
        var manifests = LocalToolManifestLocator.FindManifests([root]);

        // Assert: the rule is general, not a special case for `.ai`.
        Assert.HasCount(1, manifests);
        Assert.AreEqual(rootManifest, Path.GetFullPath(manifests[0]));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindManifests_WalksPastAProjectUnderAHiddenFolder()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var root = workspace.CreateDirectory("repo");
        var rootManifest = WriteManifest(workspace, "repo");
        WriteManifest(workspace, "repo", ".ai", "tmp", "app");
        var project = Path.Combine(root, ".ai", "tmp", "app", "app.csproj");
        File.WriteAllText(project, "<Project />");

        // Act: the walk-up guard drops the hidden owner but keeps climbing to the root.
        var manifests = LocalToolManifestLocator.FindManifests([root], [project]);

        // Assert
        Assert.HasCount(1, manifests);
        Assert.AreEqual(Path.GetFullPath(rootManifest), Path.GetFullPath(manifests[0]));
    }

    private static string WriteManifest(TemporaryDirectory workspace, params string[] folders) =>
        workspace.WriteFile(
            Path.Combine([.. folders, ".config", "dotnet-tools.json"]),
            Manifest);
}
