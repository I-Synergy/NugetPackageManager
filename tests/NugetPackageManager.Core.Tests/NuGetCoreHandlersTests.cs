// File: tests/NugetPackageManager.Core.Tests/NuGetCoreHandlersTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.

using System.Text.Json;
using Moq;
using NugetPackageManager.Core.NuGet;
using NugetPackageManager.Core.NuGet.Models;
using NugetPackageManager.Core.NuGet.Sources;
using NugetPackageManager.Core.NuGet.Vulnerabilities;
using NugetPackageManager.Core.Protocol;

namespace NugetPackageManager.Core.Tests;

[TestClass]
public class NuGetCoreHandlersTests
{
    private static readonly JsonElement validParameters =
        Parse("""{"source":{"url":"https://api.nuget.org/v3/index.json"}}""");

    private static readonly Dictionary<string, List<VulnerabilityEntry>> noEntries = [];

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetVulnerabilities_ReaderReturnsEntries_ReturnsEntriesObject()
    {
        // Arrange
        Dictionary<string, List<VulnerabilityEntry>> entries = [];
        entries["Newtonsoft.Json"] =
        [
            new VulnerabilityEntry
            {
                Url = "https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
                Severity = 2,
                Versions = "[1.0.0, 13.0.1)",
            },
        ];
        var handlers = CreateHandlers(entries);

        // Act
        var result = await handlers["getVulnerabilities"](validParameters, CancellationToken.None);

        // Assert
        var json = JsonSerializer.Serialize(result, ProtocolJson.Options);
        using var document = JsonDocument.Parse(json);
        var entry = document.RootElement.GetProperty("entries").GetProperty("Newtonsoft.Json")[0];
        Assert.AreEqual("https://github.com/advisories/GHSA-5crp-9r3c-p9vr", entry.GetProperty("url").GetString());
        Assert.AreEqual(2, entry.GetProperty("severity").GetInt32());
        Assert.AreEqual("[1.0.0, 13.0.1)", entry.GetProperty("versions").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetVulnerabilities_PassesSourceAndCredentialsToTheReader()
    {
        // Arrange
        var reader = new Mock<IVulnerabilityReader>();
        reader
            .Setup(x => x.ReadAsync(It.IsAny<SourceDescriptor>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(noEntries);
        var handlers = new NuGetCoreHandlers(reader.Object, Mock.Of<INuGetSourceProvider>()).Create();
        var parameters = Parse(
            """{"source":{"url":"https://feed.example/v3/index.json","username":"u","password":"p","proxy":"http://proxy:8080"}}""");

        // Act
        await handlers["getVulnerabilities"](parameters, CancellationToken.None);

        // Assert
        reader.Verify(
            x => x.ReadAsync(
                It.Is<SourceDescriptor>(s =>
                    s.Url == "https://feed.example/v3/index.json"
                    && s.Username == "u"
                    && s.Password == "p"
                    && s.Proxy == "http://proxy:8080"),
                It.IsAny<CancellationToken>()),
            Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetVulnerabilities_MissingSource_ReportsInvalidParams()
    {
        // Arrange
        var handlers = CreateHandlers(noEntries);

        // Act
        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["getVulnerabilities"](Parse("{}"), CancellationToken.None));

        // Assert
        Assert.AreEqual("invalidParams", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetVulnerabilities_ReaderThrows_SurfacesItsCode()
    {
        // Arrange
        var reader = new Mock<IVulnerabilityReader>();
        reader
            .Setup(x => x.ReadAsync(It.IsAny<SourceDescriptor>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new NuGetSourceException("sourceUnreachable", "feed down"));
        var handlers = new NuGetCoreHandlers(reader.Object, Mock.Of<INuGetSourceProvider>()).Create();

        // Act
        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["getVulnerabilities"](validParameters, CancellationToken.None));

        // Assert
        Assert.AreEqual("sourceUnreachable", error.Code);
        Assert.AreEqual("feed down", error.Message);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackages_PassesFilterPagingAndPrereleaseToTheSource()
    {
        // Arrange
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.SearchAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<int>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        var handlers = CreateHandlers(noEntries, source.Object);
        var parameters = Parse(
            """{"source":{"url":"https://api.nuget.org/v3/index.json"},"filter":"json","prerelease":true,"skip":40,"take":20}""");

        // Act
        await handlers["getPackages"](parameters, CancellationToken.None);

        // Assert
        source.Verify(x => x.SearchAsync("json", true, 40, 20, It.IsAny<CancellationToken>()), Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackages_NoTake_DefaultsToTwenty()
    {
        // Arrange
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.SearchAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<int>(), It.IsAny<int>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync([]);
        var handlers = CreateHandlers(noEntries, source.Object);

        // Act
        await handlers["getPackages"](validParameters, CancellationToken.None);

        // Assert
        source.Verify(x => x.SearchAsync(string.Empty, false, 0, 20, It.IsAny<CancellationToken>()), Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackage_ReturnsWhatTheSourceReturns()
    {
        // Arrange
        var package = new Package
        {
            Id = "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/13.0.3.json",
            Name = "Newtonsoft.Json",
            Authors = ["James Newton-King"],
            Description = "JSON.NET",
            IconUrl = "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/13.0.3/icon",
            LicenseUrl = string.Empty,
            ProjectUrl = "https://www.newtonsoft.com/json",
            Registration = "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json",
            TotalDownloads = 3_000_000_000,
            Verified = true,
            InstalledVersion = string.Empty,
            Version = "13.0.3",
            Versions = [new PackageVersionRef { Version = "13.0.3", Id = "leaf" }],
            Tags = ["json"],
        };
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.GetPackageAsync("Newtonsoft.Json", true, It.IsAny<CancellationToken>()))
            .ReturnsAsync(package);
        var handlers = CreateHandlers(noEntries, source.Object);
        var parameters = Parse(
            """{"source":{"url":"https://api.nuget.org/v3/index.json"},"id":"Newtonsoft.Json","prerelease":true}""");

        // Act
        var result = await handlers["getPackage"](parameters, CancellationToken.None);

        // Assert
        Assert.AreSame(package, result);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackage_WithoutId_ReportsInvalidParams()
    {
        // Arrange
        var handlers = CreateHandlers(noEntries, Mock.Of<INuGetSource>());

        // Act
        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["getPackage"](validParameters, CancellationToken.None));

        // Assert
        Assert.AreEqual("invalidParams", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackage_NotFound_SurfacesPackageNotFound()
    {
        // Arrange
        var source = new Mock<INuGetSource>();
        source
            .Setup(x => x.GetPackageAsync(It.IsAny<string>(), It.IsAny<bool>(), It.IsAny<CancellationToken>()))
            .ThrowsAsync(new NuGetSourceException("packageNotFound", "missing"));
        var handlers = CreateHandlers(noEntries, source.Object);
        var parameters = Parse(
            """{"source":{"url":"https://api.nuget.org/v3/index.json"},"id":"Nope"}""");

        // Act
        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["getPackage"](parameters, CancellationToken.None));

        // Assert
        Assert.AreEqual("packageNotFound", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetPackageDetails_WithoutUrl_ReportsInvalidParams()
    {
        // Arrange
        var handlers = CreateHandlers(noEntries, Mock.Of<INuGetSource>());

        // Act
        var error = await Assert.ThrowsExactlyAsync<RpcException>(
            () => handlers["getPackageDetails"](validParameters, CancellationToken.None));

        // Assert
        Assert.AreEqual("invalidParams", error.Code);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ClearPackageCache_WithoutId_ClearsEveryCachedPackage()
    {
        // Arrange
        var provider = new Mock<INuGetSourceProvider>();
        var handlers = new NuGetCoreHandlers(Mock.Of<IVulnerabilityReader>(), provider.Object).Create();

        // Act
        await handlers["clearPackageCache"](Parse("{}"), CancellationToken.None);

        // Assert
        provider.Verify(x => x.ClearPackageCaches(null), Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ClearVulnerabilityCache_DelegatesToTheReader()
    {
        // Arrange
        var reader = new Mock<IVulnerabilityReader>();
        var handlers = new NuGetCoreHandlers(reader.Object, Mock.Of<INuGetSourceProvider>()).Create();

        // Act
        await handlers["clearVulnerabilityCache"](Parse("{}"), CancellationToken.None);

        // Assert
        reader.Verify(x => x.ClearVulnerabilityCache(), Times.Once);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Server_WithInjectedHandlers_StillAnswersPing()
    {
        // Arrange
        var handlers = CreateHandlers(noEntries);
        using var input = new StringReader("{\"id\":1,\"method\":\"ping\"}\n");
        using var output = new StringWriter();
        using var errorOutput = new StringWriter();
        using var server = new NdjsonServer(input, output, errorOutput, handlers);

        // Act
        await server.RunAsync(CancellationToken.None).ConfigureAwait(false);

        // Assert
        Assert.IsTrue(output.ToString().Contains("\"pong\":true", StringComparison.Ordinal));
    }

    private static Dictionary<string, RpcHandler> CreateHandlers(
        Dictionary<string, List<VulnerabilityEntry>> entries,
        INuGetSource? source = null)
    {
        var reader = new Mock<IVulnerabilityReader>();
        reader
            .Setup(x => x.ReadAsync(It.IsAny<SourceDescriptor>(), It.IsAny<CancellationToken>()))
            .ReturnsAsync(entries);

        var provider = new Mock<INuGetSourceProvider>();
        provider
            .Setup(x => x.GetSource(It.IsAny<SourceDescriptor>()))
            .Returns(source ?? Mock.Of<INuGetSource>());

        return new NuGetCoreHandlers(reader.Object, provider.Object).Create();
    }

    private static JsonElement Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }
}
