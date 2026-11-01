// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/PackageMappingTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.

using System.Text.Json;
using NugetPackageManager.Core.NuGet.Sources;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

[TestClass]
public class PackageMappingTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void MapSearch_MapsEveryFieldTheWebviewReads()
    {
        // Arrange
        using var document = JsonDocument.Parse(SearchPayload);

        // Act
        var packages = PackageMapping.MapSearch(document.RootElement);

        // Assert
        Assert.AreEqual(1, packages.Count);
        var package = packages[0];
        Assert.AreEqual("https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json", package.Id);
        Assert.AreEqual("Newtonsoft.Json", package.Name);
        Assert.AreEqual("James Newton-King", package.Authors[0]);
        Assert.AreEqual("Json.NET is a popular high-performance JSON framework for .NET", package.Description);
        Assert.AreEqual(3_000_000_000, package.TotalDownloads);
        Assert.IsTrue(package.Verified);
        Assert.AreEqual("13.0.3", package.Version);
        Assert.AreEqual(string.Empty, package.InstalledVersion);
        Assert.AreEqual("https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/13.0.3.json", package.Versions[0].Id);
        Assert.AreEqual("13.0.3", package.Versions[0].Version);
        Assert.AreEqual("json", package.Tags[0]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapSearch_StringAuthors_AreWrappedInAList()
    {
        // Arrange
        using var document = JsonDocument.Parse("""
            {"data":[{"@id":"leaf","id":"Pkg","authors":"Single Author","versions":[]}]}
            """);

        // Act
        var packages = PackageMapping.MapSearch(document.RootElement);

        // Assert
        Assert.AreEqual(1, packages[0].Authors.Count);
        Assert.AreEqual("Single Author", packages[0].Authors[0]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapRegistration_PicksTheLatestStableVersion()
    {
        // Arrange
        var leaves = Leaves(
            ("1.0.0", "leaf-1"),
            ("1.10.0", "leaf-110"),
            ("1.9.0", "leaf-19"));

        // Act
        var package = PackageMapping.MapRegistration(leaves, prerelease: false);

        // Assert
        Assert.IsNotNull(package);
        Assert.AreEqual("1.10.0", package.Version);
        Assert.AreEqual("leaf-110", package.Id);
        Assert.AreEqual(3, package.Versions.Count);
        Assert.AreEqual("1.0.0", package.Versions[0].Version);
        Assert.AreEqual("1.9.0", package.Versions[1].Version);
        Assert.AreEqual("1.10.0", package.Versions[2].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapRegistration_DropsPrereleaseUnlessAskedFor()
    {
        // Arrange
        var leaves = Leaves(("1.0.0", "leaf-1"), ("2.0.0-beta", "leaf-2"));

        // Act
        var stable = PackageMapping.MapRegistration(leaves, prerelease: false);
        var all = PackageMapping.MapRegistration(leaves, prerelease: true);

        // Assert
        Assert.IsNotNull(stable);
        Assert.AreEqual("1.0.0", stable.Version);
        Assert.AreEqual(1, stable.Versions.Count);
        Assert.IsNotNull(all);
        Assert.AreEqual("2.0.0-beta", all.Version);
        Assert.AreEqual(2, all.Versions.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapRegistration_OnlyPrereleases_KeepsThem()
    {
        // Arrange
        var leaves = Leaves(("2.0.0-beta", "leaf-1"));

        // Act
        var package = PackageMapping.MapRegistration(leaves, prerelease: false);

        // Assert
        Assert.IsNotNull(package);
        Assert.AreEqual("2.0.0-beta", package.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapRegistration_NoLeaves_ReturnsNull()
    {
        // Act
        var package = PackageMapping.MapRegistration([], prerelease: false);

        // Assert
        Assert.IsNull(package);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapDependencyGroups_KeepsGroupsWithDependenciesOnly()
    {
        // Arrange
        using var document = JsonDocument.Parse(CatalogEntry);

        // Act
        var details = PackageMapping.MapDependencyGroups(document.RootElement);

        // Assert
        Assert.AreEqual(1, details.Dependencies.Frameworks.Count);
        Assert.IsTrue(details.Dependencies.Frameworks.ContainsKey(".NETStandard2.0"));
        var dependency = details.Dependencies.Frameworks[".NETStandard2.0"][0];
        Assert.AreEqual("System.Text.Json", dependency.Package);
        Assert.AreEqual("[4.7.2, )", dependency.VersionRange);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MapDependencyGroups_NoGroups_ReturnsEmptyFrameworks()
    {
        // Act
        var details = PackageMapping.MapDependencyGroups(default);

        // Assert
        Assert.AreEqual(0, details.Dependencies.Frameworks.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void CompareVersions_OrdersLikeNuGet()
    {
        // Act + Assert
        Assert.IsTrue(PackageMapping.CompareVersions("1.10.0", "1.9.0") > 0);
        Assert.IsTrue(PackageMapping.CompareVersions("1.0.0-beta", "1.0.0") < 0);
        Assert.IsTrue(PackageMapping.CompareVersions("1.0.0-beta.2", "1.0.0-beta.10") < 0);
        Assert.AreEqual(0, PackageMapping.CompareVersions("1.0.0", "1.0.0.0"));
    }

    private static List<JsonElement> Leaves(params (string Version, string Id)[] versions)
    {
        var leaves = new List<JsonElement>();

        foreach (var (version, id) in versions)
        {
            var json = "{\"@id\":\"" + id + "\",\"catalogEntry\":{\"id\":\"Pkg\",\"version\":\"" + version + "\"}}";
            using var document = JsonDocument.Parse(json);
            leaves.Add(document.RootElement.Clone());
        }

        return leaves;
    }

    private const string SearchPayload = """
        {
          "data": [
            {
              "@id": "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json",
              "id": "Newtonsoft.Json",
              "authors": ["James Newton-King"],
              "description": "Json.NET is a popular high-performance JSON framework for .NET",
              "iconUrl": "",
              "registration": "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json",
              "licenseUrl": "",
              "projectUrl": "",
              "totalDownloads": 3000000000,
              "verified": true,
              "version": "13.0.3",
              "versions": [
                { "version": "13.0.3", "@id": "https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/13.0.3.json" }
              ],
              "tags": ["json"]
            }
          ]
        }
        """;

    private const string CatalogEntry = """
        {
          "dependencyGroups": [
            {
              "targetFramework": ".NETStandard2.0",
              "dependencies": [
                { "id": "System.Text.Json", "range": "[4.7.2, )" }
              ]
            },
            {
              "targetFramework": ".NETFramework4.6.2",
              "dependencies": []
            }
          ]
        }
        """;
}
