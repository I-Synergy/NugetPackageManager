// File: tests/NugetPackageManager.Core.Tests/Diagnostics/DotnetFailureClassifierTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `dotnet-failure.test.ts`.

using NugetPackageManager.Core.Diagnostics;

namespace NugetPackageManager.Core.Tests.Diagnostics;

[TestClass]
public class DotnetFailureClassifierTests
{
    private const string WorkloadConflictOutput =
        @"C:\Program Files\dotnet\sdk\11.0.100-rc.3.26522.148\Sdks\Microsoft.NET.Sdk\targets\Microsoft.NET.Sdk.ImportWorkloads.props(14,38): error MSB4242: SDK Resolver Failure: ""The SDK resolver ""Microsoft.DotNet.MSBuildWorkloadSdkResolver"" failed while attempting to resolve the SDK ""Microsoft.NET.SDK.WorkloadAutoImportPropsLocator"". Exception: ""Microsoft.NET.Sdk.WorkloadManifestReader.WorkloadManifestCompositionException: Workload pack 'Microsoft.NET.Runtime.Emscripten.Node.net10' in manifest 'microsoft.net.workload.emscripten.net10' [C:\Program Files\dotnet\sdk-manifests\11.0.100-rc.3\microsoft.net.workload.emscripten.net10\11.0.100-rc.3.26522.148\WorkloadManifest.json] conflicts with manifest 'microsoft.net.workload.emscripten.current' [C:\Program Files\dotnet\sdk-manifests\10.0.100\microsoft.net.workload.emscripten.current\10.0.112\WorkloadManifest.json] [d:\Projects\Sample\Sample.csproj]";

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_WorkloadManifestConflict_IsAToolchainProblem()
    {
        // Act
        var failure = DotnetFailureClassifier.Classify(
            WorkloadConflictOutput,
            new DotnetFailureContext(
                ProjectPath: @"d:\Projects\Sample\Sample.csproj",
                PinnedSdkVersion: "10.0.403",
                GlobalJsonPath: @"d:\Projects\Sample\global.json"));

        // Assert
        Assert.AreEqual("WorkloadManifestConflict", failure.Kind);
        Assert.AreEqual("11.0.100-rc.3.26522.148", failure.SdkVersion);
        Assert.AreEqual("10.0.403", failure.PinnedSdkVersion);
        StringAssert.Contains(failure.Summary, "conflicting workload manifests");
        StringAssert.Contains(failure.Summary, "Microsoft.NET.Runtime.Emscripten.Node.net10");
        StringAssert.Contains(failure.Hint, "dotnet workload update");
        StringAssert.Contains(failure.Detail, "MSB4242");
        Assert.IsNull(failure.Conflicts);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_PromotedVulnerabilityAudit_IsNotAVersionConflict()
    {
        // Arrange
        const string output =
            "sample.csproj : error NU1903: Warning As Error: Package 'SQLitePCLRaw.lib.e_sqlite3' 2.1.11 has a known high severity vulnerability, https://github.com/advisories/GHSA-2m69-gcr7-jv3q\n" +
            "sample.csproj : error NU1903: Warning As Error: Package 'SQLitePCLRaw.lib.e_sqlite3.android' 2.1.11 has a known high severity vulnerability, https://github.com/advisories/GHSA-2m69-gcr7-jv3q";

        // Act
        var failure = DotnetFailureClassifier.Classify(output);

        // Assert
        Assert.AreEqual("VulnerabilityAudit", failure.Kind);
        StringAssert.Contains(failure.Summary, "SQLitePCLRaw.lib.e_sqlite3 2.1.11 (high)");
        StringAssert.Contains(failure.Hint, "WarningsAsErrors");
        StringAssert.Contains(failure.Hint, "GHSA-2m69-gcr7-jv3q");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_Nu1107_IsARestoreConflictWithParsedChains()
    {
        // Arrange
        const string output =
            "C:\\ws\\Sample.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0 directly to project Sample to resolve this issue.\n" +
            "C:\\ws\\Sample.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0).";

        // Act
        var failure = DotnetFailureClassifier.Classify(output);

        // Assert
        Assert.AreEqual("RestoreConflict", failure.Kind);
        Assert.IsNotNull(failure.Conflicts);
        Assert.AreEqual(1, failure.Conflicts.Count);
        Assert.AreEqual("Microsoft.EntityFrameworkCore.Relational", failure.Conflicts[0].PackageId);
        StringAssert.Contains(failure.Hint, "Consolidate");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_Nu1301MissingLocalSource_WinsOverAParsedConflict()
    {
        // Arrange: a stale local source and a NU1107 chain in the same output.
        const string output =
            "C:\\ws\\Sample.csproj : error NU1301: The local source 'C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\' doesn't exist.\n" +
            "C:\\ws\\Sample.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0 directly to project Sample to resolve this issue.\n" +
            "C:\\ws\\Sample.csproj :  Sample.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0).";

        // Act
        var failure = DotnetFailureClassifier.Classify(output);

        // Assert
        Assert.AreEqual("SourceUnavailable", failure.Kind);
        Assert.AreNotEqual("RestoreConflict", failure.Kind);
        StringAssert.Contains(failure.Summary, "C:\\Program Files (x86)\\Microsoft SDKs\\NuGetPackages\\");
        StringAssert.Contains(failure.Summary, "does not exist");
        StringAssert.Contains(failure.Hint, "dotnet nuget disable source");
        StringAssert.Contains(failure.Detail, "NU1301");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_Nu1301UnreachableUrl_KeepsTheNetworkHint()
    {
        // Arrange
        const string output =
            "error NU1301: Unable to load the service index for source https://feed.example/v3/index.json.";

        // Act
        var failure = DotnetFailureClassifier.Classify(output);

        // Assert
        Assert.AreEqual("SourceUnavailable", failure.Kind);
        StringAssert.Contains(failure.Summary, "https://feed.example/v3/index.json");
        StringAssert.Contains(failure.Hint, "network/proxy");
        StringAssert.Contains(failure.Hint, "credentials");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_MissingPinnedSdk_NamesTheVersionAndGlobalJson()
    {
        // Act
        var failure = DotnetFailureClassifier.Classify(
            "error MSB4236: The SDK '9.0.100' specified could not be found.",
            new DotnetFailureContext(PinnedSdkVersion: "9.0.100"));

        // Assert
        Assert.AreEqual("PinnedSdkMissing", failure.Kind);
        StringAssert.Contains(failure.Summary, "9.0.100");
        StringAssert.Contains(failure.Hint, "global.json");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_SpawnFailed_ReportsAMissingCli()
    {
        // Act
        var failure = DotnetFailureClassifier.Classify(
            "spawn dotnet ENOENT",
            new DotnetFailureContext(SpawnFailed: true));

        // Assert
        Assert.AreEqual("DotnetMissing", failure.Kind);
        StringAssert.Contains(failure.Hint, "PATH");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Classify_UnrecognizedOutput_FallsBackToUnknown()
    {
        // Act
        var failure = DotnetFailureClassifier.Classify("Something unexpected happened.");

        // Assert
        Assert.AreEqual("Unknown", failure.Kind);
        Assert.AreEqual("Something unexpected happened.", failure.Summary);
    }
}
