// File: tests/NugetPackageManager.Core.NuGet.Tests/Configuration/NuGetConfigResolverTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Ports the merge half of the TypeScript `nuget-config-resolver.test.ts`: precedence, `<clear/>`
// semantics, disabled sources, credential and mapping attachment, and failure reporting.

using NugetPackageManager.Core.NuGet.Configuration;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.NuGet.Tests.Configuration;

[TestClass]
public class NuGetConfigResolverTests
{
    private static readonly NuGetConfigEnvironment noEnvironment =
        new("linux", Path.Combine("/home", "dev"), _ => null);

    private static NuGetConfigLocation UserConfig(string name = "user") =>
        new(Path.Combine("/home", "dev", ".nuget", "NuGet", $"{name}.config"), IsWorkspace: false);

    private static NuGetConfigLocation WorkspaceConfig(string name = "workspace") =>
        new(Path.Combine("/repo", $"{name}.config"), IsWorkspace: true);

    private static NuGetConfigResolution Merge(params (NuGetConfigLocation Location, string Content)[] files)
    {
        var contents = files.ToDictionary(file => file.Location.Path, file => file.Content, StringComparer.Ordinal);
        return NuGetConfigResolver.Merge(noEnvironment, [.. files.Select(file => file.Location)], path => contents[path]);
    }

    private static void AssertCsv(IEnumerable<string> actual, string expected) =>
        Assert.AreEqual(expected, string.Join(",", actual));

    private static string Sources(params (string Name, string Url)[] sources) =>
        $"""
        <configuration>
          <packageSources>
            {string.Join(Environment.NewLine, sources.Select(source => $"<add key=\"{source.Name}\" value=\"{source.Url}\" />"))}
          </packageSources>
        </configuration>
        """;

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_LaterFileWinsAndKeepsTheOriginalPosition()
    {
        var resolution = Merge(
            (UserConfig(), """
                <configuration>
                  <packageSources>
                    <add key="shared" value="https://user.test/v3/index.json" />
                    <add key="user-only" value="https://user-only.test/v3/index.json" />
                  </packageSources>
                </configuration>
                """),
            (WorkspaceConfig(), """
                <configuration>
                  <packageSources>
                    <add key="workspace-only" value="https://workspace.test/v3/index.json" />
                    <add key="shared" value="https://workspace-shared.test/v3/index.json" />
                  </packageSources>
                </configuration>
                """));

        AssertCsv(resolution.Sources.Select(source => source.Name), "shared,user-only,workspace-only");
        Assert.AreEqual("https://workspace-shared.test/v3/index.json", resolution.Sources[0].Url);
        Assert.IsFalse(resolution.ClearFound);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_WorkspaceClearResetsSourcesAndSetsTheFlag()
    {
        var resolution = Merge(
            (UserConfig(), Sources(("user", "https://user.test/v3/index.json"))),
            (WorkspaceConfig(), """
                <configuration>
                  <packageSources>
                    <clear />
                    <add key="workspace" value="https://workspace.test/v3/index.json" />
                  </packageSources>
                </configuration>
                """));

        AssertCsv(resolution.Sources.Select(source => source.Name), "workspace");
        Assert.IsTrue(resolution.ClearFound);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_UserLevelClearDoesNotSetTheFlag()
    {
        var resolution = Merge(
            (UserConfig(), """
                <configuration>
                  <packageSources>
                    <clear />
                    <add key="user" value="https://user.test/v3/index.json" />
                  </packageSources>
                </configuration>
                """),
            (WorkspaceConfig(), Sources(("workspace", "https://workspace.test/v3/index.json"))));

        AssertCsv(resolution.Sources.Select(source => source.Name), "user,workspace");
        Assert.IsFalse(resolution.ClearFound);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_DisabledSourcesAreRemoved()
    {
        var resolution = Merge(
            (UserConfig(), """
                <configuration>
                  <packageSources>
                    <add key="on" value="https://on.test/v3/index.json" />
                    <add key="off" value="https://off.test/v3/index.json" />
                  </packageSources>
                  <disabledPackageSources>
                    <add key="off" value="true" />
                  </disabledPackageSources>
                </configuration>
                """));

        AssertCsv(resolution.Sources.Select(source => source.Name), "on");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_AttachesCredentialsAndMappingPatterns()
    {
        var resolution = Merge(
            (UserConfig(), """
                <configuration>
                  <packageSources>
                    <add key="private" value="https://private.test/v3/index.json" />
                  </packageSources>
                  <packageSourceCredentials>
                    <private>
                      <add key="Username" value="dev" />
                      <add key="ClearTextPassword" value="plain" />
                    </private>
                  </packageSourceCredentials>
                  <packageSourceMapping>
                    <packageSource key="private">
                      <package pattern="Contoso.*" />
                    </packageSource>
                  </packageSourceMapping>
                </configuration>
                """));

        var source = resolution.Sources.Single();
        Assert.AreEqual("dev", source.Username);
        Assert.AreEqual("plain", source.Password);
        AssertCsv(source.Patterns!, "Contoso.*");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_ReportsUnreadableAndMalformedFiles_AndKeepsGoing()
    {
        var malformed = UserConfig("malformed");

        var resolution = Merge(
            (UserConfig(), """
                <configuration>
                  <packageSources>
                    <add key="user" value="https://user.test/v3/index.json" />
                  </packageSources>
                </configuration>
                """),
            (malformed, "<configuration>"));

        Assert.AreEqual(1, resolution.Sources.Count);
        Assert.AreEqual(1, resolution.Failures.Count);
        Assert.AreEqual(malformed.Path, resolution.Failures[0].Path);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Merge_ReadFailureIsReportedAsAFailure()
    {
        var location = UserConfig();
        var resolution = NuGetConfigResolver.Merge(
            noEnvironment,
            [location],
            _ => throw new IOException("locked"));

        Assert.AreEqual(0, resolution.Sources.Count);
        Assert.AreEqual(1, resolution.Failures.Count);
        Assert.AreEqual("locked", resolution.Failures[0].Message);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Resolve_DiscoversAndMergesRealFiles_WithoutExpandingWorkspaceVariables()
    {
        using var home = new TemporaryDirectory("nuget-config-home");
        home.WriteFile(
            Path.Combine(".nuget", "NuGet", "NuGet.Config"),
            """
            <configuration>
              <packageSources>
                <add key="user" value="https://user.test/v3/index.json" />
              </packageSources>
            </configuration>
            """);

        using var workspace = new TemporaryDirectory("nuget-config-workspace");
        workspace.WriteFile(
            "nuget.config",
            """
            <configuration>
              <packageSources>
                <add key="private" value="https://private.test/v3/index.json" />
              </packageSources>
              <packageSourceCredentials>
                <private>
                  <add key="Username" value="dev" />
                  <add key="ClearTextPassword" value="%NUGET_TOKEN%" />
                </private>
              </packageSourceCredentials>
            </configuration>
            """);

        var environment = new NuGetConfigEnvironment(
            "linux",
            home.Root,
            name => name == "NUGET_TOKEN" ? "s3cret" : null);

        var resolution = NuGetConfigResolver.Resolve(environment, [workspace.Root], File.ReadAllText);

        AssertCsv(resolution.Sources.Select(source => source.Name), "user,private");
        Assert.AreEqual(0, resolution.Failures.Count);

        // The workspace config may not read the developer's environment and hand it to a feed.
        Assert.AreEqual("%NUGET_TOKEN%", resolution.Sources[1].Password);
    }
}
