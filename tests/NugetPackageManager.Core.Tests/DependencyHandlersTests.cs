// File: tests/NugetPackageManager.Core.Tests/DependencyHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.

using System.Text.Json;
using Moq;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.Protocol;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class DependencyHandlersTests
{
    private static readonly JsonElement closureParameters = Parse("""
        {
          "selected": [{ "id": "A", "version": "2.0.0" }],
          "tfms": ["net10.0"],
          "effective": { "b": "1.0.0", "c": "1.0.0" },
          "constrained": { "net10.0": ["a"] },
          "constrainAll": true,
          "maxInspected": 250,
          "sources": [{ "url": "https://feed.example/v3/index.json" }]
        }
        """);

    [TestMethod]
    [TestCategory("Unit")]
    public async Task AnalyzeProjectDependencies_MissingAssets_ReportsSkipped()
    {
        // Arrange
        var directory = Directory.CreateTempSubdirectory("dependency-handlers-");
        try
        {
            var projectPath = Path.Combine(directory.FullName, "App.csproj");
            File.WriteAllText(projectPath, "<Project />");
            var handlers = CreateHandlers(Mock.Of<INuGetSourceProvider>());

            // Act
            var result = await handlers["analyzeProjectDependencies"](
                Parse(JsonSerializer.Serialize(new { projectPath })),
                CancellationToken.None);

            // Assert
            var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
            using var document = JsonDocument.Parse(json);
            Assert.IsTrue(document.RootElement.GetProperty("Skipped").GetBoolean());
            Assert.AreEqual(
                "project has not been restored",
                document.RootElement.GetProperty("Reason").GetString());
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task AnalyzeProjectDependencies_MissingProjectPath_ReportsInvalidParams()
    {
        // Arrange
        var handlers = CreateHandlers(Mock.Of<INuGetSourceProvider>());

        // Act / Assert
        await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["analyzeProjectDependencies"](Parse("{}"), CancellationToken.None));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ComputeRequirementClosure_ReadsDependencyMetadataFromTheSource()
    {
        // Arrange
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.GetPackageAsync("A", true, It.IsAny<CancellationToken>()))
            .ReturnsAsync(Package("2.0.0"));
        source
            .Setup(x => x.GetPackageDetailsAsync("A", "2.0.0", It.IsAny<CancellationToken>()))
            .ReturnsAsync(Details(("net10.0", [new PackageDependency
            {
                Package = "B",
                VersionRange = "[2.0.0, )",
            }])));

        var handlers = CreateHandlers(Provider(source));

        // Act
        var result = await handlers["computeRequirementClosure"](closureParameters, CancellationToken.None);

        // Assert
        var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
        using var document = JsonDocument.Parse(json);
        var conflict = document.RootElement.GetProperty("Conflicts")[0];
        Assert.AreEqual("B", conflict.GetProperty("PackageId").GetString());
        Assert.AreEqual("A", conflict.GetProperty("RequiredBy").GetString());
        Assert.AreEqual("2.0.0", conflict.GetProperty("RequiredVersion").GetString());
        Assert.AreEqual("2.0.0", document.RootElement.GetProperty("Planned").GetProperty("b").GetString());

        source.Verify(
            x => x.GetPackageDetailsAsync("A", "2.0.0", It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ComputeRequirementClosure_PrefersTheSameMajorFrameworkGroup()
    {
        // Arrange
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.GetPackageAsync("A", true, It.IsAny<CancellationToken>()))
            .ReturnsAsync(Package("2.0.0"));
        source
            .Setup(x => x.GetPackageDetailsAsync(It.IsAny<string>(), It.IsAny<string>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(Details(
                ("net9.0", [new PackageDependency { Package = "Old", VersionRange = "[9.0.0, )" }]),
                ("net10.0-windows", [new PackageDependency { Package = "C", VersionRange = "[2.0.0, )" }])));

        var handlers = CreateHandlers(Provider(source));

        // Act
        var result = await handlers["computeRequirementClosure"](closureParameters, CancellationToken.None);

        // Assert
        var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
        using var document = JsonDocument.Parse(json);
        Assert.AreEqual(
            "C",
            document.RootElement.GetProperty("Conflicts")[0].GetProperty("PackageId").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task OrderRequirements_ReturnsTheApplyOrder()
    {
        // Arrange
        var handlers = CreateHandlers(Mock.Of<INuGetSourceProvider>());
        var parameters = Parse("""
            {
              "conflicts": [
                { "packageId": "Core", "requiredBy": "Globalization", "requiredByVersion": "1.0.0", "range": "[1.0.0, )", "requiredVersion": "1.0.0", "tfm": "net10.0" },
                { "packageId": "Microsoft.Extensions.Hosting", "requiredBy": "Core", "requiredByVersion": "1.0.0", "range": "[1.0.0, )", "requiredVersion": "1.0.0", "tfm": "net10.0" }
              ]
            }
            """);

        // Act
        var result = await handlers["orderRequirements"](parameters, CancellationToken.None);

        // Assert
        var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
        using var document = JsonDocument.Parse(json);
        var orders = document.RootElement.GetProperty("orders");
        Assert.AreEqual(0, orders.GetProperty("microsoft.extensions.hosting").GetProperty("Order").GetInt32());
        Assert.AreEqual(1, orders.GetProperty("core").GetProperty("Order").GetInt32());
        Assert.AreEqual(2, orders.GetProperty("globalization").GetProperty("Order").GetInt32());
    }

    private static Dictionary<string, RpcHandler> CreateHandlers(INuGetSourceProvider providers) =>
        new DependencyHandlers(providers).Create();

    private static INuGetSourceProvider Provider(Mock<INuGetSource> source)
    {
        var provider = new Mock<INuGetSourceProvider>();
        provider
            .Setup(x => x.GetSource(It.IsAny<SourceDescriptor>()))
            .Returns(source.Object);
        return provider.Object;
    }

    private static Package Package(params string[] versions) => new()
    {
        Id = "leaf",
        Name = "A",
        Authors = [],
        Description = string.Empty,
        IconUrl = string.Empty,
        LicenseUrl = string.Empty,
        ProjectUrl = string.Empty,
        Registration = string.Empty,
        TotalDownloads = 0,
        Verified = false,
        InstalledVersion = string.Empty,
        Version = versions[^1],
        Versions = [.. versions.Select(version => new PackageVersionRef(version))],
        Tags = [],
    };

    private static PackageDetails Details(
        params (string Tfm, List<PackageDependency> Dependencies)[] groups) =>
        new()
        {
            Dependencies = new PackageDependencyGroup
            {
                Frameworks = groups.ToDictionary(group => group.Tfm, group => group.Dependencies),
            },
        };

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();
}
