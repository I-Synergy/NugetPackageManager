// File: tests/NugetPackageManager.Core.Tests/Toolchain/GlobalJsonTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors the edit path of `global-json.test.ts`; the template-creation path stays in the
// host because it spawns `dotnet new globaljson`.

using System.Text.Json;
using NugetPackageManager.Core.Toolchain;

namespace NugetPackageManager.Core.Tests.Toolchain;

[TestClass]
public class GlobalJsonTests
{
    private static readonly string[] expectedRollForwardNote = ["sdk.rollForward set to disable"];

    private DirectoryInfo root = null!;

    [TestInitialize]
    public void Initialize()
    {
        root = Directory.CreateTempSubdirectory("global-json-");
    }

    [TestCleanup]
    public void Cleanup()
    {
        root.Delete(recursive: true);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void IsValidSdkVersion_AcceptsConcreteVersionsOnly()
    {
        Assert.IsTrue(GlobalJson.IsValidSdkVersion("10.0.403"));
        Assert.IsTrue(GlobalJson.IsValidSdkVersion("11.0.100-rc.3.26522.148"));
        Assert.IsFalse(GlobalJson.IsValidSdkVersion("latest"));
        Assert.IsFalse(GlobalJson.IsValidSdkVersion("10.0"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_CreatesGlobalJsonAtTheWorkspaceRoot()
    {
        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.403");

        // Assert
        Assert.AreEqual(Path.Combine(root.FullName, "global.json"), result.GlobalJsonPath);
        Assert.IsTrue(result.Created);
        Assert.IsTrue(result.Changed);

        using var document = JsonDocument.Parse(File.ReadAllText(result.GlobalJsonPath));
        var sdk = document.RootElement.GetProperty("sdk");
        Assert.AreEqual("10.0.403", sdk.GetProperty("version").GetString());
        Assert.AreEqual("disable", sdk.GetProperty("rollForward").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_ReplacesThePinAndKeepsUnrelatedKeys()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, """
            {
              "sdk": { "version": "10.0.403", "rollForward": "latestPatch", "allowPrerelease": false },
              "msbuild-sdks": { "Some.Sdk": "1.2.3" }
            }
            """);

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.404");

        // Assert
        Assert.IsTrue(result.Changed);
        Assert.AreEqual("10.0.403", result.PreviousVersion);
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        var sdk = document.RootElement.GetProperty("sdk");
        Assert.AreEqual("10.0.404", sdk.GetProperty("version").GetString());
        Assert.AreEqual("disable", sdk.GetProperty("rollForward").GetString());
        Assert.IsFalse(sdk.GetProperty("allowPrerelease").GetBoolean());
        Assert.AreEqual(
            "1.2.3",
            document.RootElement.GetProperty("msbuild-sdks").GetProperty("Some.Sdk").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_AddsAVersionToAnSdkSectionWithoutOne()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, "{\n  \"sdk\": {\n    \"rollForward\": \"latestMinor\"\n  }\n}\n");

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.403");

        // Assert
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        var sdk = document.RootElement.GetProperty("sdk");
        Assert.AreEqual("10.0.403", sdk.GetProperty("version").GetString());
        Assert.AreEqual("disable", sdk.GetProperty("rollForward").GetString());
        Assert.IsTrue(result.Changed);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_IsANoOpWhenTheVersionIsAlreadyPinnedCoherently()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(
            globalJson,
            "{\n  \"sdk\": {\n    \"version\": \"10.0.403\",\n    \"rollForward\": \"disable\"\n  }\n}\n");

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.403");

        // Assert
        Assert.IsFalse(result.Changed);
        Assert.IsFalse(result.Created);
        Assert.AreEqual(0, result.Notes.Count);
        Assert.AreEqual(globalJson, result.GlobalJsonPath);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_AddsRollForwardToAVersionOnlyPin()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, "{\n  \"sdk\": {\n    \"version\": \"10.0.403\"\n  }\n}\n");

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.403");

        // Assert
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        Assert.AreEqual("disable", document.RootElement.GetProperty("sdk").GetProperty("rollForward").GetString());
        Assert.IsTrue(result.Changed);
        CollectionAssert.AreEqual(expectedRollForwardNote, result.Notes.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_UpdatesTheNearestGlobalJson()
    {
        // Arrange
        var nested = Directory.CreateDirectory(Path.Combine(root.FullName, "src", "App"));
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, "{\"sdk\":{\"version\":\"10.0.403\"}}");

        // Act
        var result = GlobalJson.UpdateFile(nested.FullName, "9.0.320");

        // Assert
        Assert.AreEqual(globalJson, result.GlobalJsonPath);
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        Assert.AreEqual("9.0.320", document.RootElement.GetProperty("sdk").GetProperty("version").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_KeepsWorkloadVersionAndToolsDotnetCoherent()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, """
            {
              "sdk": {
                "version": "10.0.403",
                "rollForward": "latestPatch",
                "allowPrerelease": false,
                "workloadVersion": "10.0.401.1"
              },
              "tools": {
                "dotnet": "10.0.403"
              },
              "test": {
                  "runner": "Microsoft.Testing.Platform"
              }
            }
            """);

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "11.0.100-rc.3.26522.148");

        // Assert
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        var sdk = document.RootElement.GetProperty("sdk");
        Assert.AreEqual("11.0.100-rc.3.26522.148", sdk.GetProperty("version").GetString());
        Assert.IsTrue(sdk.GetProperty("allowPrerelease").GetBoolean());
        Assert.IsFalse(sdk.TryGetProperty("workloadVersion", out _));
        Assert.AreEqual(
            "11.0.100-rc.3.26522.148",
            document.RootElement.GetProperty("tools").GetProperty("dotnet").GetString());
        Assert.AreEqual(
            "Microsoft.Testing.Platform",
            document.RootElement.GetProperty("test").GetProperty("runner").GetString());
        Assert.AreEqual(4, result.Notes.Count);
        Assert.AreEqual("disable", sdk.GetProperty("rollForward").GetString());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_KeepsWorkloadVersionInTheSameFeatureBand()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        File.WriteAllText(globalJson, """
            {
              "sdk": { "version": "10.0.403", "workloadVersion": "10.0.401.1" },
              "tools": { "dotnet": "10.0.403" }
            }
            """);

        // Act
        var result = GlobalJson.UpdateFile(root.FullName, "10.0.403");

        // Assert
        using var document = JsonDocument.Parse(File.ReadAllText(globalJson));
        var sdk = document.RootElement.GetProperty("sdk");
        Assert.AreEqual("10.0.401.1", sdk.GetProperty("workloadVersion").GetString());
        Assert.AreEqual("disable", sdk.GetProperty("rollForward").GetString());
        CollectionAssert.AreEqual(expectedRollForwardNote, result.Notes.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void UpdateFile_RejectsAnInvalidVersionWithoutTouchingTheFile()
    {
        // Arrange
        var globalJson = Path.Combine(root.FullName, "global.json");
        const string original = "{\"sdk\":{\"version\":\"10.0.403\"}}";
        File.WriteAllText(globalJson, original);

        // Act / Assert
        Assert.ThrowsExactly<ArgumentException>(() => GlobalJson.UpdateFile(root.FullName, "latest"));
        Assert.AreEqual(original, File.ReadAllText(globalJson));
    }
}
