// File: tests/NugetPackageManager.Core.Tests/Toolchain/LocalToolToolchainAnalysisTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// The two local-tool findings: a manifest that cannot be used, and a declared tool this machine
// has not restored. The evaluator stays pure — the host hands the facts in.

using System.Text.Json;
using NugetPackageManager.Core.Toolchain;

namespace NugetPackageManager.Core.Tests.Toolchain;

[TestClass]
public class LocalToolToolchainAnalysisTests
{
    private const string ManifestPath = "D:\\ws\\.config\\dotnet-tools.json";

    private static readonly string[] expectedManifestPaths = [ManifestPath];

    private static readonly string[] expectedNotRestoredToolIds = ["reportgenerator"];

    private static readonly string[] expectedIssueKinds = ["DotnetMissing", "LocalToolNotRestored"];

    private static readonly string[] expectedManifestProblems = ["duplicate command"];

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_MalformedManifest_AddsTheManifestInvalidIssue()
    {
        // Arrange
        var input = HealthyProbe() with
        {
            LocalTools =
            [
                new LocalToolProbe
                {
                    ManifestPath = ManifestPath,
                    Problems = ["The manifest is not valid JSON: '}' is invalid after a value."],
                    Tools = [],
                },
            ],
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.AreEqual(1, health.Issues.Count);
        Assert.AreEqual("LocalToolManifestInvalid", health.Issues[0].Kind);
        StringAssert.Contains(health.Issues[0].Summary, ManifestPath);
        StringAssert.Contains(health.Issues[0].Detail!, "not valid JSON");
        CollectionAssert.AreEqual(expectedManifestPaths, health.LocalToolManifests!.ToArray());
        Assert.IsNull(health.LocalToolsNotRestored);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_ToolThatIsNotRestored_AddsTheNotRestoredIssue()
    {
        // Arrange
        var input = HealthyProbe() with
        {
            LocalTools =
            [
                new LocalToolProbe
                {
                    ManifestPath = ManifestPath,
                    Tools =
                    [
                        new LocalToolProbeTool { Id = "dotnet-ef", Version = "8.0.10", Restored = true },
                        new LocalToolProbeTool { Id = "reportgenerator", Version = "5.3.11", Restored = false },
                    ],
                },
            ],
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.AreEqual(1, health.Issues.Count);
        Assert.AreEqual("LocalToolNotRestored", health.Issues[0].Kind);
        StringAssert.Contains(health.Issues[0].Summary, "reportgenerator (5.3.11)");
        Assert.DoesNotContain("dotnet-ef (", health.Issues[0].Summary, StringComparison.Ordinal);
        CollectionAssert.AreEqual(expectedNotRestoredToolIds, health.LocalToolsNotRestored!.ToArray());
        CollectionAssert.AreEqual(expectedManifestPaths, health.LocalToolManifests!.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_UnprobedTools_SayNothingAndStillListTheManifest()
    {
        // Arrange: a probe that did not run must not turn into a "not restored" claim.
        var input = HealthyProbe() with
        {
            LocalTools =
            [
                new LocalToolProbe
                {
                    ManifestPath = ManifestPath,
                    Tools = [new LocalToolProbeTool { Id = "dotnet-ef", Version = "8.0.10" }],
                },
            ],
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.AreEqual(0, health.Issues.Count);
        Assert.IsNull(health.LocalToolsNotRestored);
        CollectionAssert.AreEqual(expectedManifestPaths, health.LocalToolManifests!.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_WithoutTheLocalToolSlice_KeepsTheExistingAnswer()
    {
        // Act
        var health = ToolchainAnalysis.Evaluate(HealthyProbe());

        // Assert
        Assert.AreEqual(0, health.Issues.Count);
        Assert.IsNull(health.LocalToolManifests);
        Assert.IsNull(health.LocalToolsNotRestored);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_MissingDotnet_StillReportsTheLocalToolFindings()
    {
        // Arrange
        var input = HealthyProbe() with
        {
            Version = new CommandOutput(null, string.Empty, "spawn dotnet ENOENT", "ENOENT"),
            LocalTools =
            [
                new LocalToolProbe
                {
                    ManifestPath = ManifestPath,
                    Tools = [new LocalToolProbeTool { Id = "dotnet-ef", Version = "8.0.10", Restored = false }],
                },
            ],
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.IsFalse(health.DotnetFound);
        CollectionAssert.AreEqual(
            expectedIssueKinds,
            health.Issues.Select(issue => issue.Kind).ToArray());
        Assert.IsNotNull(health.LocalToolsNotRestored);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ProbeReader_ReadsTheLocalToolSlice()
    {
        // Arrange
        using var parameters = JsonDocument.Parse(
            """
            {
              "localTools": [
                {
                  "manifestPath": "D:\\ws\\.config\\dotnet-tools.json",
                  "problems": ["duplicate command"],
                  "tools": [
                    { "id": "dotnet-ef", "version": "8.0.10", "restored": false },
                    { "id": "", "version": "1.0.0", "restored": true },
                    { "id": "reportgenerator", "version": "5.3.11" },
                    { "version": "9.9.9" }
                  ]
                },
                { "problems": ["no path"] }
              ]
            }
            """);

        // Act
        var probes = LocalToolProbeReader.Read(parameters.RootElement);

        // Assert
        Assert.HasCount(1, probes);
        Assert.AreEqual("D:\\ws\\.config\\dotnet-tools.json", probes[0].ManifestPath);
        CollectionAssert.AreEqual(expectedManifestProblems, probes[0].Problems.ToArray());
        Assert.HasCount(2, probes[0].Tools);
        Assert.AreEqual(false, probes[0].Tools[0].Restored);
        Assert.IsNull(probes[0].Tools[1].Restored);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ProbeReader_ToleratesAMissingSlice()
    {
        using var parameters = JsonDocument.Parse("""{"command":"dotnet"}""");

        Assert.IsEmpty(LocalToolProbeReader.Read(parameters.RootElement));
    }

    private static ToolchainProbeInput HealthyProbe() =>
        new()
        {
            ProjectPath = "D:\\ws\\App.csproj",
            Command = "dotnet",
            Version = new CommandOutput(0, "10.0.403", string.Empty),
            SdkList = new CommandOutput(0, "10.0.403 [C:\\Program Files\\dotnet\\sdk]", string.Empty),
            Evaluation = new CommandOutput(0, """{"Properties":{"NETCoreSdkVersion":"10.0.403"}}""", string.Empty),
            CheckedAt = "2026-11-01T00:00:00.000Z",
        };
}
