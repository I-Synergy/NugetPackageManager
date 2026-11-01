// File: tests/NugetPackageManager.Core.Tests/WorkspaceHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The writer itself is covered by golden files in Core.Workspace.Tests; this checks the
// protocol surface: parameter parsing, scope names and error codes.

using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class WorkspaceHandlersTests
{
    private string directory = string.Empty;
    private string propsPath = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        directory = Path.Combine(Path.GetTempPath(), "workspace-handlers", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        propsPath = Path.Combine(directory, "Directory.Packages.props");
        File.WriteAllText(propsPath, """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);
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
    public async Task UpdateCpmVersions_AppliesTheChange()
    {
        var handlers = CreateHandlers();
        var parameters = Serialize(new
        {
            propsFilePath = propsPath,
            changes = new[] { new { packageId = "Newtonsoft.Json", version = "13.0.4", scope = "first" } },
        });

        // Act
        var result = await handlers["updateCpmVersions"](parameters, CancellationToken.None);

        // Assert
        Assert.IsNotNull(result);
        StringAssert.Contains(File.ReadAllText(propsPath), "Version=\"13.0.4\"");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateCpmVersions_MissingPath_ReportsInvalidParams()
    {
        var handlers = CreateHandlers();

        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["updateCpmVersions"](Parse("""{"changes":[]}"""), CancellationToken.None));

        Assert.AreEqual("invalidParams", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateCpmVersions_UnknownScope_ReportsInvalidParams()
    {
        var handlers = CreateHandlers();
        var parameters = Serialize(new
        {
            propsFilePath = propsPath,
            changes = new[] { new { packageId = "Newtonsoft.Json", version = "13.0.4", scope = "sideways" } },
        });

        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["updateCpmVersions"](parameters, CancellationToken.None));

        Assert.AreEqual("invalidParams", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RemovePackageVersion_ReportsWhetherAnythingWasRemoved()
    {
        var handlers = CreateHandlers();

        var parameters = Serialize(new { propsFilePath = propsPath, packageId = "Newtonsoft.Json" });

        var removed = await handlers["removePackageVersion"](parameters, CancellationToken.None);
        var missing = await handlers["removePackageVersion"](parameters, CancellationToken.None);

        var removedJson = JsonSerializer.Serialize(removed, ProtocolJson.Options);
        var missingJson = JsonSerializer.Serialize(missing, ProtocolJson.Options);
        StringAssert.Contains(removedJson, "\"removed\":true");
        StringAssert.Contains(missingJson, "\"removed\":false");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetCpmMap_ReturnsUnconditionalAndConditionalGroups()
    {
        File.WriteAllText(propsPath, """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Pkg.Shared" Version="1.0.0" />
              </ItemGroup>
              <ItemGroup Condition="$(TargetFramework.StartsWith('net10.0'))">
                <PackageVersion Include="Pkg.Shared" Version="2.0.0" />
              </ItemGroup>
            </Project>
            """);
        var handlers = CreateHandlers();

        // Act
        var result = await handlers["getCpmMap"](
            Serialize(new { propsFilePath = propsPath }),
            CancellationToken.None);

        // Assert
        var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        Assert.AreEqual("1.0.0", root.GetProperty("unconditional").GetProperty("Pkg.Shared").GetString());
        Assert.IsTrue(root.GetProperty("hasConditionalGroups").GetBoolean());
        var group = root.GetProperty("conditional")[0];
        Assert.AreEqual("net10.0", group.GetProperty("framework").GetString());
        Assert.AreEqual("2.0.0", group.GetProperty("versions").GetProperty("Pkg.Shared").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetCpmMap_MissingFile_ReturnsNull()
    {
        var handlers = CreateHandlers();

        var result = await handlers["getCpmMap"](
            Serialize(new { propsFilePath = Path.Combine(directory, "Absent.props") }),
            CancellationToken.None);

        Assert.IsNull(result);
    }

    private static Dictionary<string, RpcHandler> CreateHandlers() =>
        new WorkspaceHandlers(new WorkspaceModelService()).Create();

    private static JsonElement Serialize(object payload) =>
        Parse(JsonSerializer.Serialize(payload));

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
