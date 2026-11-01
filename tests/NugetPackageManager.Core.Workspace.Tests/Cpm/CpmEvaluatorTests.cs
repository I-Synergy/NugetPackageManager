// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmEvaluatorTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Exercises the `-getItem` JSON parsing without spawning `dotnet msbuild`; the process itself is
// verified by the opt-in E2E run, not the unit suite.

using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
public class CpmEvaluatorTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_BothItemArrays_ReadsEvaluatedVersions()
    {
        // Arrange — the property `$(FooBarVersion)` was evaluated to 1.2.3 by MSBuild.
        const string json = """
            {
              "Properties": { "TargetFramework": "" },
              "Items": {
                "PackageVersion": [
                  { "Identity": "Foo.Bar", "Version": "1.2.3", "DefiningProjectFullPath": "/tmp/Directory.Packages.props" }
                ],
                "PackageReference": [
                  { "Identity": "Newtonsoft.Json", "Version": "13.0.3" }
                ]
              }
            }
            """;

        // Act
        var evaluation = CpmEvaluator.ParseEvaluation(json);

        // Assert
        Assert.IsNotNull(evaluation);
        Assert.AreEqual("1.2.3", evaluation.CentralVersions["Foo.Bar"]);
        Assert.AreEqual("13.0.3", evaluation.PackageReferences["Newtonsoft.Json"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_PackageIdLookup_IsCaseInsensitive()
    {
        // Arrange
        const string json = """
            { "Items": { "PackageVersion": [ { "Identity": "Foo.Bar", "Version": "1.2.3" } ] } }
            """;

        // Act
        var evaluation = CpmEvaluator.ParseEvaluation(json);

        // Assert
        Assert.IsNotNull(evaluation);
        Assert.AreEqual("1.2.3", evaluation.CentralVersions["foo.bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_MissingItemArray_IsEmptyNotFatal()
    {
        // Arrange — only PackageVersion is present.
        const string json = """
            { "Items": { "PackageVersion": [ { "Identity": "Foo.Bar", "Version": "1.2.3" } ] } }
            """;

        // Act
        var evaluation = CpmEvaluator.ParseEvaluation(json);

        // Assert
        Assert.IsNotNull(evaluation);
        Assert.AreEqual(1, evaluation.CentralVersions.Count);
        Assert.AreEqual(0, evaluation.PackageReferences.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_ItemWithoutVersion_IsIgnored()
    {
        // Arrange
        const string json = """
            { "Items": { "PackageVersion": [ { "Identity": "No.Version" }, { "Identity": "Foo.Bar", "Version": "1.2.3" } ] } }
            """;

        // Act
        var evaluation = CpmEvaluator.ParseEvaluation(json);

        // Assert
        Assert.IsNotNull(evaluation);
        Assert.AreEqual(1, evaluation.CentralVersions.Count);
        Assert.IsFalse(evaluation.CentralVersions.ContainsKey("No.Version"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_MissingItems_ReturnsNull()
    {
        // Act + Assert — no `Items` means the payload is not a valid evaluation.
        Assert.IsNull(CpmEvaluator.ParseEvaluation("""{ "Properties": { "TargetFramework": "" } }"""));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_EmptyInput_ReturnsNull()
    {
        Assert.IsNull(CpmEvaluator.ParseEvaluation(string.Empty));
        Assert.IsNull(CpmEvaluator.ParseEvaluation("   "));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_NonJsonOutput_ReturnsNull()
    {
        // Arrange — older SDKs print `Property = value` lines instead of JSON.
        const string output = "TargetFramework = net8.0";

        // Act + Assert
        Assert.IsNull(CpmEvaluator.ParseEvaluation(output));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseEvaluation_MalformedJson_ReturnsNull()
    {
        // Act + Assert
        Assert.IsNull(CpmEvaluator.ParseEvaluation("""{ "Items": { "PackageVersion": [ """));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task ClearCache_AfterEvaluation_DropsCachedEntryAsync()
    {
        // Arrange — a minimal project so the spawned evaluation has something to parse. The
        // result itself is irrelevant here (it may legitimately be null); only caching matters.
        using var directory = new TemporaryDirectory("cpm-evaluator-clear");
        var projectPath = directory.WriteFile(
            "probe.csproj",
            """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net8.0</TargetFramework>
              </PropertyGroup>
            </Project>
            """);

        using var evaluator = new CpmEvaluator();
        _ = await evaluator
            .EvaluateAsync(projectPath, targetFramework: null, CancellationToken.None)
            .ConfigureAwait(false);

        Assert.IsTrue(evaluator.CachedEntryCount > 0, "the first evaluation must be cached");

        // Act
        evaluator.ClearCache();

        // Assert
        Assert.AreEqual(0, evaluator.CachedEntryCount);
    }
}
