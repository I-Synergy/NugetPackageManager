// File: tests/NugetPackageManager.Core.Workspace.Tests/Tools/LocalToolManifestWriterTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The manifest rewrite is a targeted edit: one version string changes, the rest of the file —
// including line endings, a byte-order mark and fields the reader does not model — does not.

using System.Text;
using NugetPackageManager.Core.Workspace.Tools;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Tools;

[TestClass]
public class LocalToolManifestWriterTests
{
    private const string Multiple = "multiple";
    private const string ToolName = "dotnet-reportgenerator-globaltool";

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_ChangesOnlyTheTargetVersion()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", Multiple);
        var before = await File.ReadAllTextAsync(path);

        // Act
        var result = await LocalToolManifestWriter.UpdateVersionAsync(path, ToolName, "5.3.11", "6.0.0");

        // Assert: the file differs by exactly the one version string.
        var after = await File.ReadAllTextAsync(path);
        Assert.AreEqual("5.3.11", result.PreviousVersion);
        Assert.AreEqual("6.0.0", result.Version);
        Assert.AreEqual(ToolName, result.ToolId);
        Assert.AreEqual(before.Replace("\"5.3.11\"", "\"6.0.0\"", StringComparison.Ordinal), after);

        var document = await LocalToolManifestReader.ReadAsync(path);
        Assert.IsTrue(document.IsValid);
        Assert.AreEqual("6.0.0", document.FindTool(ToolName)!.Version);
        Assert.AreEqual("8.0.10", document.FindTool("dotnet-ef")!.Version);
        Assert.IsTrue(document.FindTool("dotnet-ef")!.Pinned);
        Assert.HasCount(3, document.Tools);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_PreservesFieldsItDoesNotModel()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", "unknown-fields");

        await LocalToolManifestWriter.UpdateVersionAsync(path, "dotnet-ef", "8.0.10", "9.0.1");

        var after = await File.ReadAllTextAsync(path);
        StringAssert.Contains(after, "\"$schema\"");
        StringAssert.Contains(after, "\"comment\"");
        StringAssert.Contains(after, "\"description\"");
        StringAssert.Contains(after, "\"owner\": \"data-team\"");
        StringAssert.Contains(after, "\"version\": \"9.0.1\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_PreservesTheByteOrderMarkAndCrlfLineEndings()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = workspace.Combine(".config", "dotnet-tools.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var crlf = File.ReadAllText(TestPaths.Fixture("tools", "single", ".config", "dotnet-tools.json"))
            .ReplaceLineEndings("\r\n");
        await File.WriteAllTextAsync(path, crlf, new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));

        // Act
        await LocalToolManifestWriter.UpdateVersionAsync(path, "dotnet-ef", "8.0.10", "9.0.1");

        // Assert
        var bytes = await File.ReadAllBytesAsync(path);
        Assert.IsTrue(bytes.Length > 3, "the file keeps a body after its byte-order mark");
        Assert.AreEqual((byte)0xEF, bytes[0]);
        Assert.AreEqual((byte)0xBB, bytes[1]);
        Assert.AreEqual((byte)0xBF, bytes[2]);

        var text = Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        StringAssert.Contains(text, "\"version\": \"9.0.1\"");
        StringAssert.Contains(text, "\r\n");
        Assert.DoesNotContain('\n', text.Replace("\r\n", string.Empty, StringComparison.Ordinal));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RefusesAStaleExpectedVersion()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", Multiple);
        var before = await File.ReadAllTextAsync(path);

        // Act
        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, ToolName, "5.0.0", "6.0.0"));

        // Assert
        Assert.AreEqual("versionMismatch", error.Code);
        Assert.AreEqual(before, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RefusesAnUnknownTool()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", Multiple);

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, "not-a-tool", "1.0.0", "2.0.0"));

        Assert.AreEqual("toolNotFound", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RefusesAnUnusableVersion()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", Multiple);

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, ToolName, "5.3.11", "latest"));

        Assert.AreEqual("invalidVersion", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RefusesAMalformedManifest()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", "malformed");
        var before = await File.ReadAllTextAsync(path);

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, "dotnet-ef", "8.0.10", "9.0.1"));

        Assert.AreEqual("invalidManifest", error.Code);
        Assert.AreEqual(before, await File.ReadAllTextAsync(path));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RefusesAMissingManifest()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = workspace.Combine(".config", "dotnet-tools.json");

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, "dotnet-ef", "8.0.10", "9.0.1"));

        Assert.AreEqual("manifestNotFound", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionAsync_RequiresEveryArgument()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = CopyFixture(workspace, "tools", Multiple);

        await Assert.ThrowsExactlyAsync<ArgumentException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(" ", ToolName, "5.3.11", "6.0.0"));
        await Assert.ThrowsExactlyAsync<ArgumentException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, " ", "5.3.11", "6.0.0"));
        await Assert.ThrowsExactlyAsync<ArgumentException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, ToolName, " ", "6.0.0"));
        await Assert.ThrowsExactlyAsync<ArgumentException>(() =>
            LocalToolManifestWriter.UpdateVersionAsync(path, ToolName, "5.3.11", " "));
    }

    /// <summary>Copies a fixture manifest into the temporary workspace.</summary>
    private static string CopyFixture(TemporaryDirectory workspace, params string[] folders)
    {
        string[] segments = [.. folders, ".config", "dotnet-tools.json"];
        var source = TestPaths.Fixture(segments);
        var target = workspace.Combine(segments);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(source, target);
        return target;
    }
}
