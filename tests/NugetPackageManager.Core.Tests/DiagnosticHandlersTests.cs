// File: tests/NugetPackageManager.Core.Tests/DiagnosticHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The classification rules themselves live in DotnetFailureClassifier; this pins the RPC
// surface: the context is read from the request and the failure shape comes back intact.

using System.Text.Json;
using NugetPackageManager.Core.Diagnostics;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class DiagnosticHandlersTests
{
    private static RpcHandler Handler() => DiagnosticHandlers.Create()["classifyDotnetFailure"];

    private static JsonElement Serialize(object value) => JsonSerializer.SerializeToElement(value);

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Classify_ReportsASpawnFailure()
    {
        var result = await Handler()(
            Serialize(new { output = "", projectPath = "/ws/App.csproj", spawnFailed = true }),
            CancellationToken.None);

        var info = (DotnetFailureInfo)result!;
        Assert.AreEqual("DotnetMissing", info.Kind);
        Assert.AreEqual("/ws/App.csproj", info.ProjectPath);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Classify_FallsBackToUnknown()
    {
        var result = await Handler()(
            Serialize(new { output = "some output without a known diagnostic", spawnFailed = false }),
            CancellationToken.None);

        var info = (DotnetFailureInfo)result!;
        Assert.AreEqual("Unknown", info.Kind);
        Assert.IsFalse(string.IsNullOrWhiteSpace(info.Summary));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Classify_WithoutOutput_ReportsInvalidParams()
    {
        var error = await Assert.ThrowsExactlyAsync<RpcException>(() =>
            Handler()(Serialize(new { projectPath = "/ws/App.csproj" }), CancellationToken.None));

        Assert.AreEqual(Constants.InvalidParams, error.Code);
    }
}
