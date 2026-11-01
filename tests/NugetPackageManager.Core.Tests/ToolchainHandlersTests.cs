// File: tests/NugetPackageManager.Core.Tests/ToolchainHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Protocol surface of the toolchain handlers: the host spawns every `dotnet` command, so the
// handler only parses the probe it is handed and reports what the core derived from it.

using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Toolchain;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class ToolchainHandlersTests
{
    private string directory = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        directory = Path.Combine(Path.GetTempPath(), "toolchain-handlers", Guid.NewGuid().ToString("N"));
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

    private static RpcHandler Handler(string name) => ToolchainHandlers.Create()[name];

    private static JsonElement Serialize(object value) => JsonSerializer.SerializeToElement(value);

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateGlobalJson_WritesThePin()
    {
        var result = await Handler("updateGlobalJsonSdkVersion")(
            Serialize(new { startDirectory = directory, version = "10.0.403" }),
            CancellationToken.None);

        var update = (GlobalJsonUpdateResult)result!;
        Assert.AreEqual(Path.Combine(directory, "global.json"), update.GlobalJsonPath);
        Assert.IsTrue(File.Exists(update.GlobalJsonPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateGlobalJson_RejectsAnInvalidVersion()
    {
        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateGlobalJsonSdkVersion")(
                Serialize(new { startDirectory = directory, version = "not-a-version" }),
                CancellationToken.None));

        Assert.AreEqual(RpcException.InvalidParams, error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateGlobalJson_RequiresStartDirectory()
    {
        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("updateGlobalJsonSdkVersion")(
                Serialize(new { version = "10.0.403" }),
                CancellationToken.None));

        Assert.AreEqual(RpcException.InvalidParams, error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task EvaluateToolchain_ReadsTheProbe()
    {
        var result = await Handler("evaluateToolchain")(
            Serialize(new
            {
                projectPath = directory,
                command = "dotnet",
                globalJsonPath = Path.Combine(directory, "global.json"),
                pinnedSdkVersion = "10.0.403",
                checkedAt = "2026-11-01T00:00:00Z",
                version = new { code = 0, stdout = "10.0.403\n", stderr = "" },
                sdkList = new { code = 0, stdout = "10.0.403 [C:/Program Files/dotnet/sdk]\n", stderr = "" },
                evaluation = new { code = 0, stdout = "net10.0\n", stderr = "" },
                sdkCheckOutput = "{}",
                privateSdkVersions = new object[] { "10.0.100", 42 },
            }),
            CancellationToken.None);

        var health = (ToolchainHealthInfo)result!;
        Assert.AreEqual("2026-11-01T00:00:00Z", health.CheckedAt);
        Assert.IsTrue(health.InstalledSdks.Count > 0);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task EvaluateToolchain_RequiresTheVersionOutput()
    {
        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("evaluateToolchain")(
                Serialize(new
                {
                    command = "dotnet",
                    checkedAt = "2026-11-01T00:00:00Z",
                    sdkList = new { stdout = "10.0.403" },
                }),
                CancellationToken.None));

        Assert.AreEqual(RpcException.InvalidParams, error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task EvaluateToolchain_RequiresTheSdkListOutput()
    {
        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler("evaluateToolchain")(
                Serialize(new
                {
                    command = "dotnet",
                    checkedAt = "2026-11-01T00:00:00Z",
                    version = new { stdout = "10.0.403" },
                }),
                CancellationToken.None));

        Assert.AreEqual(RpcException.InvalidParams, error.Code);
    }
}
