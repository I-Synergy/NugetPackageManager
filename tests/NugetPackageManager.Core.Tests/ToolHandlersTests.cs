// File: tests/NugetPackageManager.Core.Tests/ToolHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Protocol surface of the local tool handlers: parameters are validated before anything is
// touched, a manifest is only edited inside a workspace root, and the core never restores.

using System.Text.Json;
using NugetPackageManager.Common;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace.Tools;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class ToolHandlersTests : IDisposable
{
    private const string ToolName = "dotnet-ef";

    private const string ManifestText = """
        {
          "version": 1,
          "isRoot": true,
          "tools": {
            "dotnet-ef": {
              "version": "8.0.10",
              "commands": [
                "dotnet-ef"
              ]
            }
          }
        }
        """;

    private static readonly string[] toolCommands = ["dotnet-ef"];

    private TemporaryDirectory workspace = null!;
    private NuGetSourceProvider sources = null!;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("tool-handlers");
        sources = new NuGetSourceProvider();
    }

    public void Dispose()
    {
        sources.Dispose();
        workspace.Dispose();
        GC.SuppressFinalize(this);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadLocalTools_ReadsTheManifestWithoutResolvingLatest()
    {
        var root = CreateWorkspace();
        WriteManifest(root);

        var result = await Handler("readLocalTools")(
            Serialize(new
            {
                workspaceRoots = new[] { root },
                resolveLatest = false,
            }),
            CancellationToken.None);

        var response = (GetLocalToolsResponse)result!;
        Assert.HasCount(1, response.Manifests);

        var manifest = response.Manifests[0];
        Assert.IsTrue(manifest.IsRoot);
        Assert.IsEmpty(manifest.Problems);
        Assert.HasCount(1, manifest.Tools);

        var tool = manifest.Tools[0];
        Assert.AreEqual(ToolName, tool.Id);
        Assert.AreEqual("8.0.10", tool.Version);
        CollectionAssert.AreEqual(toolCommands, tool.Commands.ToArray());
        Assert.IsFalse(tool.UpdateAvailable);
        Assert.IsNull(tool.LatestVersion);
        Assert.IsFalse(tool.Pinned);
        Assert.IsFalse(tool.NotRestored);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadLocalTools_ResolvesNothingWithoutASource()
    {
        var root = CreateWorkspace();
        WriteManifest(root);

        // resolveLatest defaults to true, but no source was passed, so nothing is asked online.
        var result = await Handler("readLocalTools")(
            Serialize(new { workspaceRoots = new[] { root } }),
            CancellationToken.None);

        var response = (GetLocalToolsResponse)result!;
        Assert.IsFalse(response.Manifests[0].Tools[0].UpdateAvailable);
        Assert.IsNull(response.Manifests[0].Tools[0].LatestVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadLocalTools_ReportsAMalformedManifestAsProblems()
    {
        var root = CreateWorkspace();
        WriteManifest(root, "{ \"version\": 1, \"tools\": { \"dotnet-ef\": { \"version\": \"8.0.10\" } }");

        var result = await Handler("readLocalTools")(
            Serialize(new { workspaceRoots = new[] { root }, resolveLatest = false }),
            CancellationToken.None);

        var manifest = ((GetLocalToolsResponse)result!).Manifests[0];
        Assert.HasCount(1, manifest.Problems);
        Assert.IsEmpty(manifest.Tools);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ReadLocalTools_AnswersEmptyWithoutWorkspaceRoots()
    {
        var result = await Handler("readLocalTools")(
            Serialize(new { workspaceRoots = Array.Empty<string>() }),
            CancellationToken.None);

        Assert.IsEmpty(((GetLocalToolsResponse)result!).Manifests);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_PinsTheNewVersion()
    {
        var root = CreateWorkspace();
        var manifestPath = WriteManifest(root);

        var result = await Handler("updateLocalTool")(
            Serialize(new
            {
                manifestPath,
                toolId = ToolName,
                expectedVersion = "8.0.10",
                version = "9.0.1",
                workspaceRoots = new[] { root },
            }),
            CancellationToken.None);

        var response = (UpdateLocalToolResponse)result!;
        Assert.AreEqual(Path.GetFullPath(manifestPath), response.ManifestPath);
        Assert.AreEqual(ToolName, response.ToolId);
        Assert.AreEqual("8.0.10", response.PreviousVersion);
        Assert.AreEqual("9.0.1", response.Version);
        Assert.IsNull(response.Restore);

        var document = await LocalToolManifestReader.ReadAsync(manifestPath);
        Assert.AreEqual("9.0.1", document.FindTool(ToolName)!.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_RejectsAManifestOutsideTheWorkspace()
    {
        var root = CreateWorkspace();
        var elsewhere = workspace.CreateDirectory("elsewhere");
        var manifestPath = WriteManifest(elsewhere);

        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateLocalTool")(
                Serialize(new
                {
                    manifestPath,
                    toolId = ToolName,
                    expectedVersion = "8.0.10",
                    version = "9.0.1",
                    workspaceRoots = new[] { root },
                }),
                CancellationToken.None));

        Assert.AreEqual(Constants.InvalidParams, error.Code);
        StringAssert.Contains(error.Message, "outside the workspace");

        var document = await LocalToolManifestReader.ReadAsync(manifestPath);
        Assert.AreEqual("8.0.10", document.FindTool(ToolName)!.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_RejectsARelativePath()
    {
        var root = CreateWorkspace();
        WriteManifest(root);

        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateLocalTool")(
                Serialize(new
                {
                    manifestPath = Path.Combine(".config", "dotnet-tools.json"),
                    toolId = ToolName,
                    expectedVersion = "8.0.10",
                    version = "9.0.1",
                    workspaceRoots = new[] { root },
                }),
                CancellationToken.None));

        Assert.AreEqual(Constants.InvalidParams, error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_RejectsAFileThatIsNotAManifest()
    {
        var root = CreateWorkspace();
        var otherFile = workspace.WriteFile(Path.Combine("repo", "notes.json"), "{}");

        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateLocalTool")(
                Serialize(new
                {
                    manifestPath = otherFile,
                    toolId = ToolName,
                    expectedVersion = "8.0.10",
                    version = "9.0.1",
                    workspaceRoots = new[] { root },
                }),
                CancellationToken.None));

        Assert.AreEqual(Constants.InvalidParams, error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_RequiresEveryParameter()
    {
        var root = CreateWorkspace();
        var manifestPath = WriteManifest(root);
        object[] incomplete =
        [
            new { toolId = ToolName, expectedVersion = "8.0.10", version = "9.0.1", workspaceRoots = new[] { root } },
            new { manifestPath, expectedVersion = "8.0.10", version = "9.0.1", workspaceRoots = new[] { root } },
            new { manifestPath, toolId = ToolName, version = "9.0.1", workspaceRoots = new[] { root } },
            new { manifestPath, toolId = ToolName, expectedVersion = "8.0.10", workspaceRoots = new[] { root } },
            new { manifestPath, toolId = ToolName, expectedVersion = "8.0.10", version = "9.0.1" },
        ];

        foreach (var parameters in incomplete)
        {
            var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
                Handler("updateLocalTool")(Serialize(parameters), CancellationToken.None));

            Assert.AreEqual(Constants.InvalidParams, error.Code);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateLocalTool_ReportsAStaleExpectedVersion()
    {
        var root = CreateWorkspace();
        var manifestPath = WriteManifest(root);

        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateLocalTool")(
                Serialize(new
                {
                    manifestPath,
                    toolId = ToolName,
                    expectedVersion = "8.0.9",
                    version = "9.0.1",
                    workspaceRoots = new[] { root },
                }),
                CancellationToken.None));

        Assert.AreEqual("versionMismatch", error.Code);
    }

    private RpcHandler Handler(string name) => new ToolHandlers(sources).Create()[name];

    private static JsonElement Serialize(object value) => JsonSerializer.SerializeToElement(value);

    private string CreateWorkspace() => workspace.CreateDirectory("repo");

    private string WriteManifest(string root, string text = ManifestText) =>
        workspace.WriteFile(Path.Combine(root, ".config", "dotnet-tools.json"), text);
}
