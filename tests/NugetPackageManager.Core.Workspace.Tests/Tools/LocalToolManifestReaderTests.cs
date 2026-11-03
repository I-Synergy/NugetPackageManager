// File: tests/NugetPackageManager.Core.Workspace.Tests/Tools/LocalToolManifestReaderTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Reading `.config/dotnet-tools.json`: the schema, the tool list, and everything that makes a
// manifest unusable reported as a problem instead of an exception.

using System.Text;
using NugetPackageManager.Core.Workspace.Tools;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Tools;

[TestClass]
public class LocalToolManifestReaderTests
{
    private static readonly string[] singleToolCommands = ["dotnet-ef"];

    private static readonly string[] multipleToolIds =
    [
        "dotnet-ef",
        "dotnet-reportgenerator-globaltool",
        "swashbuckle.aspnetcore.cli",
    ];

    private static readonly string[] swashbuckleCommands = ["dotnet-swagger", "swagger"];

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_ReadsASingleToolManifest()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "single", ".config", "dotnet-tools.json"));

        // Assert
        Assert.IsTrue(document.IsValid);
        Assert.IsEmpty(document.Problems);
        Assert.AreEqual("1", document.Version);
        Assert.IsTrue(document.IsRoot);
        Assert.IsFalse(document.HasByteOrderMark);
        Assert.HasCount(1, document.Tools);

        var tool = document.Tools[0];
        Assert.AreEqual("dotnet-ef", tool.Id);
        Assert.AreEqual("8.0.10", tool.Version);
        CollectionAssert.AreEqual(singleToolCommands, tool.Commands.ToArray());
        Assert.IsNull(tool.RollForward);
        Assert.IsFalse(tool.Pinned);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_ReadsEveryToolInManifestOrder()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "multiple", ".config", "dotnet-tools.json"));

        // Assert
        Assert.IsTrue(document.IsValid);
        CollectionAssert.AreEqual(
            multipleToolIds,
            document.Tools.Select(tool => tool.Id).ToArray());
        CollectionAssert.AreEqual(
            swashbuckleCommands,
            document.FindTool("swashbuckle.aspnetcore.cli")!.Commands.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_ReportsAPinnedTool()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "multiple", ".config", "dotnet-tools.json"));

        // Assert
        var pinned = document.FindTool("dotnet-ef")!;
        Assert.AreEqual(false, pinned.RollForward);
        Assert.IsTrue(pinned.Pinned);
        Assert.IsFalse(document.FindTool("dotnet-reportgenerator-globaltool")!.Pinned);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_ToleratesFieldsItDoesNotModel()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "unknown-fields", ".config", "dotnet-tools.json"));

        // Assert
        Assert.IsTrue(document.IsValid);
        Assert.IsEmpty(document.Problems);
        Assert.AreEqual("8.0.10", document.FindTool("dotnet-ef")!.Version);
        StringAssert.Contains(document.Text, "\"$schema\"");
        StringAssert.Contains(document.Text, "\"extra\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_ReportsMalformedJsonWithoutThrowing()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "malformed", ".config", "dotnet-tools.json"));

        // Assert
        Assert.IsFalse(document.Parsed);
        Assert.IsFalse(document.IsValid);
        Assert.HasCount(1, document.Problems);
        Assert.IsEmpty(document.Tools);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_AcceptsAManifestWithoutTools()
    {
        // Act
        var document = await LocalToolManifestReader.ReadAsync(
            TestPaths.Fixture("tools", "empty", ".config", "dotnet-tools.json"));

        // Assert
        Assert.IsTrue(document.IsValid);
        Assert.IsEmpty(document.Tools);
        Assert.IsFalse(document.IsRoot);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadAsync_KeepsTheByteOrderMarkAndLineEndings()
    {
        using var workspace = new TemporaryDirectory("local-tools");
        var path = workspace.Combine(".config", "dotnet-tools.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(
            path,
            File.ReadAllText(TestPaths.Fixture("tools", "single", ".config", "dotnet-tools.json"))
                .ReplaceLineEndings("\r\n"),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: true));

        // Act
        var document = await LocalToolManifestReader.ReadAsync(path);

        // Assert
        Assert.IsTrue(document.HasByteOrderMark);
        Assert.IsTrue(document.IsValid);
        StringAssert.Contains(document.Text, "\r\n");
        Assert.AreEqual("8.0.10", document.FindTool("dotnet-ef")!.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsAMissingVersion()
    {
        var document = LocalToolManifestReader.Parse(
            "dotnet-tools.json",
            """{"isRoot":true,"tools":{"dotnet-ef":{"version":"8.0.10","commands":["dotnet-ef"]}}}""");

        Assert.IsFalse(document.IsValid);
        StringAssert.Contains(string.Join(" ", document.Problems), "`version`");
        Assert.IsNull(document.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsAnUnsupportedSchemaVersion()
    {
        var document = LocalToolManifestReader.Parse(
            "dotnet-tools.json",
            """{"version":2,"isRoot":true,"tools":{}}""");

        Assert.IsFalse(document.IsValid);
        StringAssert.Contains(string.Join(" ", document.Problems), "version '2'");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsAnEmptyToolId()
    {
        var document = LocalToolManifestReader.Parse(
            "dotnet-tools.json",
            """{"version":1,"tools":{"":{"version":"1.0.0","commands":["x"]}}}""");

        Assert.IsFalse(document.IsValid);
        StringAssert.Contains(string.Join(" ", document.Problems), "empty id");
        Assert.IsEmpty(document.Tools);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsDuplicateCommandNames()
    {
        var document = LocalToolManifestReader.Parse(
            "dotnet-tools.json",
            """
            {"version":1,"tools":{
              "tool-a":{"version":"1.0.0","commands":["shared"]},
              "tool-b":{"version":"2.0.0","commands":["shared"]}}}
            """);

        Assert.IsFalse(document.IsValid);
        StringAssert.Contains(string.Join(" ", document.Problems), "Command 'shared' is declared by both 'tool-a' and 'tool-b'");
        Assert.HasCount(2, document.Tools);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_ReportsAMissingToolVersionAndNoUsableCommand()
    {
        var document = LocalToolManifestReader.Parse(
            "dotnet-tools.json",
            """{"version":1,"tools":{"tool-a":{"commands":[]}}}""");

        var problems = string.Join(" ", document.Problems);
        StringAssert.Contains(problems, "has no `version`");
        StringAssert.Contains(problems, "no usable command name");
        Assert.HasCount(1, document.Tools);
        Assert.AreEqual(string.Empty, document.Tools[0].Version);
    }
}
