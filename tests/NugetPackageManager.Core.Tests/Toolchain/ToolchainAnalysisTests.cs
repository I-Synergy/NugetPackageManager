// File: tests/NugetPackageManager.Core.Tests/Toolchain/ToolchainAnalysisTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `toolchain-health.test.ts` and `sdk-check.test.ts`, plus the high-level evaluation
// that the host now calls after capturing `dotnet` output.

using NugetPackageManager.Core.Toolchain;

namespace NugetPackageManager.Core.Tests.Toolchain;

[TestClass]
public class ToolchainAnalysisTests
{
    private static readonly string[] expectedSdkVersions =
        ["9.0.320", "10.0.403", "11.0.100-rc.3.26522.148"];
    private static readonly string[] privateVersions = ["10.0.403", "9.0.100"];
    private static readonly string[] expectedMerged = ["10.0.403:system", "9.0.100:private"];

    private const string SdkCheckSample =
        ".NET SDKs:\n" +
        "Version                      Status\n" +
        "-------------------------------------------------------------------\n" +
        "9.0.320                      .NET 9.0 is going out of support soon.\n" +
        "10.0.403                     Up to date.\n" +
        "11.0.100-rc.3.26522.148      Up to date.\n" +
        "\n" +
        ".NET Runtimes:\n" +
        "Name                              Version                    Status\n" +
        "---------------------------------------------------------------------------------------------------\n" +
        "Microsoft.AspNetCore.App          10.0.8                     Patch 10.0.14 is available.\n" +
        "Microsoft.NETCore.App             10.0.14                    Up to date.\n";

    [TestMethod]
    [TestCategory("Unit")]
    public void SdkSatisfiesPin_FollowsRollForward()
    {
        Assert.IsTrue(ToolchainAnalysis.SdkSatisfiesPin("10.0.403", "10.0.403", null));
        Assert.IsFalse(ToolchainAnalysis.SdkSatisfiesPin("11.0.100-rc.3", "10.0.403", "latestPatch"));
        Assert.IsFalse(ToolchainAnalysis.SdkSatisfiesPin("10.0.404", "10.0.403", "disable"));
        Assert.IsTrue(ToolchainAnalysis.SdkSatisfiesPin("10.0.404", "10.0.403", "latestPatch"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseSdkList_ReadsDotnetListSdksOutput()
    {
        // Act
        var sdks = ToolchainAnalysis.ParseSdkList(
            "10.0.403 [C:\\Program Files\\dotnet\\sdk]\r\n9.0.320 [C:\\Program Files\\dotnet\\sdk]\r\n");

        // Assert
        Assert.AreEqual(2, sdks.Count);
        Assert.AreEqual("10.0.403", sdks[0].Version);
        Assert.AreEqual("C:\\Program Files\\dotnet\\sdk", sdks[0].Path);
        Assert.AreEqual("system", sdks[0].Source);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void MergeInstalledSdks_AddsPrivateSdksWithoutDuplicatingVersions()
    {
        // Act
        var merged = ToolchainAnalysis.MergeInstalledSdks(
            [new InstalledSdkInfo { Version = "10.0.403", Path = "C:\\dotnet\\sdk", Source = "system" }],
            privateVersions);

        // Assert
        CollectionAssert.AreEqual(
            expectedMerged,
            merged.Select(sdk => $"{sdk.Version}:{sdk.Source}").ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseMsBuildProperty_ReadsTheSdkTheBuildResolved()
    {
        // Arrange
        const string output =
            "MSBuild version 17.14.8 for .NET\n{\n  \"Properties\": {\n    \"TargetFramework\": \"net10.0\",\n    \"NETCoreSdkVersion\": \"10.0.403\"\n  }\n}";

        // Act / Assert
        Assert.AreEqual("10.0.403", ToolchainAnalysis.ParseMsBuildProperty(output, "NETCoreSdkVersion"));
        Assert.IsNull(ToolchainAnalysis.ParseMsBuildProperty(output, "Missing"));
        Assert.IsNull(ToolchainAnalysis.ParseMsBuildProperty("not json", "NETCoreSdkVersion"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_LeftoverManifestBand_IsReported()
    {
        // Arrange
        var dotnetRoot = Directory.CreateTempSubdirectory("dotnet-root-");
        try
        {
            Directory.CreateDirectory(Path.Combine(dotnetRoot.FullName, "sdk-manifests", "10.0.100", "workload"));
            Directory.CreateDirectory(Path.Combine(dotnetRoot.FullName, "sdk-manifests", "10.0.400", "workload"));
            var input = HealthyProbe() with
            {
                SdkList = new CommandOutput(
                    0,
                    $"10.0.403 [{Path.Combine(dotnetRoot.FullName, "sdk")}]",
                    string.Empty),
            };

            // Act
            var health = ToolchainAnalysis.Evaluate(input);

            // Assert
            Assert.IsNotNull(health.OrphanedManifestBands);
            Assert.AreEqual(1, health.OrphanedManifestBands.Count);
            Assert.AreEqual(
                Path.Combine(dotnetRoot.FullName, "sdk-manifests", "10.0.100"),
                health.OrphanedManifestBands[0]);
        }
        finally
        {
            dotnetRoot.Delete(recursive: true);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseSdkCheck_ReadsTheSdkAndRuntimeTables()
    {
        // Act
        var result = ToolchainAnalysis.ParseSdkCheck(SdkCheckSample);

        // Assert
        Assert.IsFalse(result.Unavailable);
        CollectionAssert.AreEqual(
            expectedSdkVersions,
            result.Sdks.Select(row => row.Version).ToArray());
        Assert.AreEqual(".NET 9.0 is going out of support soon.", result.Sdks[0].Status);
        Assert.AreEqual("Up to date.", result.Sdks[1].Status);
        Assert.AreEqual("Microsoft.AspNetCore.App", result.Runtimes[0].Name);
        Assert.AreEqual("10.0.8", result.Runtimes[0].Version);
        Assert.AreEqual("Patch 10.0.14 is available.", result.Runtimes[0].Status);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseSdkCheck_ReportsUnusableOutputAsUnavailable()
    {
        foreach (var output in new[] { "", "   ", "Something went wrong\n" })
        {
            var result = ToolchainAnalysis.ParseSdkCheck(output);
            Assert.IsTrue(result.Unavailable, output);
            Assert.AreEqual(0, result.Sdks.Count);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void FindSdkStatus_MatchesTheExactVersionAndThenTheBand()
    {
        // Arrange
        var result = ToolchainAnalysis.ParseSdkCheck(SdkCheckSample);

        // Act / Assert
        Assert.AreEqual("Up to date.", ToolchainAnalysis.FindSdkStatus(result, "10.0.403"));
        Assert.AreEqual("Up to date.", ToolchainAnalysis.FindSdkStatus(result, "10.0.499"));
        Assert.IsNull(ToolchainAnalysis.FindSdkStatus(result, "8.0.100"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_HealthyToolchain_ReportsTheSelectedAndBuildSdk()
    {
        // Act
        var health = ToolchainAnalysis.Evaluate(HealthyProbe());

        // Assert
        Assert.IsTrue(health.DotnetFound);
        Assert.AreEqual("10.0.403", health.SdkVersion);
        Assert.AreEqual("10.0.403", health.BuildSdkVersion);
        Assert.AreEqual("Up to date.", health.SdkStatus);
        Assert.IsFalse(health.ProjectEvaluationFailed);
        Assert.AreEqual(1, health.InstalledSdks.Count);
        Assert.AreEqual(0, health.Issues.Count);
        Assert.IsNull(health.SdkMatchesPin);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_PinMismatch_AddsAnIssue()
    {
        // Arrange
        var input = HealthyProbe() with { PinnedSdkVersion = "9.0.100" };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.IsFalse(health.SdkMatchesPin!.Value);
        Assert.AreEqual("SdkPinMismatch", health.Issues[0].Kind);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_BuildResolvesAnotherSdk_AddsTheSelectionMismatch()
    {
        // Arrange
        var input = HealthyProbe() with
        {
            Evaluation = new CommandOutput(0, """{"Properties":{"NETCoreSdkVersion":"10.0.404"}}""", string.Empty),
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.AreEqual("10.0.404", health.BuildSdkVersion);
        Assert.IsFalse(health.ProjectEvaluationFailed);
        Assert.AreEqual("SdkSelectionMismatch", health.Issues[0].Kind);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_MissingDotnet_ReportsTheSpawnFailure()
    {
        // Arrange
        var input = HealthyProbe() with
        {
            Version = new CommandOutput(null, string.Empty, "spawn dotnet ENOENT", "ENOENT"),
        };

        // Act
        var health = ToolchainAnalysis.Evaluate(input);

        // Assert
        Assert.IsFalse(health.DotnetFound);
        Assert.AreEqual("DotnetMissing", health.Issues[0].Kind);
        Assert.IsFalse(health.ProjectEvaluationFailed);
    }

    private static ToolchainProbeInput HealthyProbe() =>
        new()
        {
            ProjectPath = "D:\\ws\\App.csproj",
            Command = "dotnet",
            Version = new CommandOutput(0, "10.0.403", string.Empty),
            SdkList = new CommandOutput(0, "10.0.403 [C:\\Program Files\\dotnet\\sdk]", string.Empty),
            Evaluation = new CommandOutput(0, """{"Properties":{"NETCoreSdkVersion":"10.0.403"}}""", string.Empty),
            SdkCheckOutput = SdkCheckSample,
            CheckedAt = "2026-11-01T00:00:00.000Z",
        };
}
