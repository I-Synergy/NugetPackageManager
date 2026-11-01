// File: tests/NugetPackageManager.Core.Tests/ConfigurationHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The resolver itself is covered in Core.NuGet.Tests; this checks the protocol surface:
// parameter parsing, the wire shape and the error code for a missing required field.

using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class ConfigurationHandlersTests
{
    private static readonly RpcHandler handler = ConfigurationHandlers.Create()["resolveNuGetConfig"];

    [TestMethod]
    [TestCategory("Unit")]
    public void Create_ExposesTheResolveMethod()
    {
        var handlers = ConfigurationHandlers.Create();

        Assert.IsTrue(handlers.ContainsKey("resolveNuGetConfig"));
        Assert.AreEqual(1, handlers.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveNuGetConfig_ReturnsSourcesAndTheClearFlag()
    {
        using var home = new TemporaryDirectory("config-handler-home");
        using var workspace = new TemporaryDirectory("config-handler-workspace");
        workspace.WriteFile(
            "nuget.config",
            """
            <configuration>
              <packageSources>
                <clear />
                <add key="local" value="https://local.test/v3/index.json" />
              </packageSources>
              <packageSourceCredentials>
                <local>
                  <add key="Username" value="dev" />
                  <add key="ClearTextPassword" value="plain" />
                </local>
              </packageSourceCredentials>
            </configuration>
            """);

        var result = await handler(
            Parameters(workspace.Root, home.Root),
            CancellationToken.None);

        var json = JsonSerializer.SerializeToElement(result, ProtocolJson.Options);
        var sources = json.GetProperty("sources");

        Assert.AreEqual(1, sources.GetArrayLength());
        Assert.AreEqual("local", sources[0].GetProperty("name").GetString());
        Assert.AreEqual("dev", sources[0].GetProperty("username").GetString());
        Assert.AreEqual("plain", sources[0].GetProperty("password").GetString());
        Assert.IsTrue(json.GetProperty("clearFound").GetBoolean());
        Assert.AreEqual(0, json.GetProperty("failures").GetArrayLength());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveNuGetConfig_ReportsAMalformedFileWithoutFailing()
    {
        using var home = new TemporaryDirectory("config-handler-broken-home");
        using var workspace = new TemporaryDirectory("config-handler-broken-workspace");
        var configPath = workspace.WriteFile("nuget.config", "<configuration>");

        var result = await handler(Parameters(workspace.Root, home.Root), CancellationToken.None);

        var json = JsonSerializer.SerializeToElement(result, ProtocolJson.Options);
        var failures = json.GetProperty("failures");

        Assert.AreEqual(1, failures.GetArrayLength());
        Assert.AreEqual(configPath, failures[0].GetProperty("path").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ResolveNuGetConfig_WithoutPlatform_ThrowsInvalidParams()
    {
        using var workspace = new TemporaryDirectory("config-handler-params");

        var parameters = JsonSerializer.SerializeToElement(new { workspaceRoots = new[] { workspace.Root } });

        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handler(parameters, CancellationToken.None));

        Assert.AreEqual("invalidParams", error.Code);
    }

    private static JsonElement Parameters(string workspaceRoot, string homeDirectory) =>
        JsonSerializer.SerializeToElement(new
        {
            workspaceRoots = new[] { workspaceRoot },
            platform = "linux",
            homeDirectory,
        });
}
