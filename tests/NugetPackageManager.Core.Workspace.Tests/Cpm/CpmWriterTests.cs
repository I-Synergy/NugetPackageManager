// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmWriterTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Every expected file in tests/NugetPackageManager.TestUtilities/Fixtures/cpm/expected was produced by the TypeScript
// `UpdateCpmVersionsAsync` / `RemovePackageVersionAsync` before the port. The comparison is
// byte for byte on purpose: the writer edits text surgically so the user's formatting survives,
// and a reformat would be a visible regression.

using NugetPackageManager.Core.Workspace.Cpm;
using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.TestUtilities;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the workspace.")]
public class CpmWriterTests
{
    private TemporaryDirectory? workspace;
    private string propsPath = string.Empty;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("cpm-writer");
        propsPath = workspace.Combine("Directory.Packages.props");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_FirstScope_MatchesTheGoldenFile()
    {
        await AssertGoldenAsync(
            "single-group.props",
            [new CpmVersionChange("Newtonsoft.Json", "13.0.4")],
            "single-group.first.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_GroupScope_TouchesOnlyThatItemGroup()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "1.5.0", "$(TargetFramework.StartsWith('net10.0'))", CpmWriteScope.Group)],
            "unconditional-plus-conditional.group.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_UnconditionalScope_LeavesFrameworkLinesAlone()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "3.0.0", Condition: null, Scope: CpmWriteScope.Unconditional)],
            "unconditional-plus-conditional.unconditional.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_AllScope_RewritesEveryOccurrence()
    {
        await AssertGoldenAsync(
            "unconditional-plus-conditional.props",
            [new CpmVersionChange("Pkg.Shared", "9.9.9", Condition: null, Scope: CpmWriteScope.All)],
            "unconditional-plus-conditional.all.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_NegatedCondition_MatchesByCombinedCondition()
    {
        await AssertGoldenAsync(
            "negated-positive.props",
            [new CpmVersionChange("Microsoft.Extensions.Logging", "11.0.0-rc.3", "$(TargetFramework.StartsWith('net11.0'))", CpmWriteScope.Group)],
            "negated-positive.group.props");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RemovePackageVersionAsync_RemovesOnlyThatPackage()
    {
        var before = CopyFixture("unconditional-plus-conditional.props");

        var removed = await CpmWriter.RemovePackageVersionAsync(propsPath, "Pkg.UnconditionalOnly");

        Assert.IsTrue(removed);
        var expected = File.ReadAllText(GoldenPath("unconditional-plus-conditional.removed.props"));
        Assert.AreEqual(expected, File.ReadAllText(propsPath));
        Assert.AreNotEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task RemovePackageVersionAsync_PackageAbsent_ReturnsFalseAndLeavesTheFile()
    {
        var before = CopyFixture("single-group.props");

        var removed = await CpmWriter.RemovePackageVersionAsync(propsPath, "Not.There");

        Assert.IsFalse(removed);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_UnknownCondition_FailsAndLeavesTheFile()
    {
        var before = CopyFixture("unconditional-plus-conditional.props");

        var error = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath,
                [new CpmVersionChange("Pkg.Shared", "1.5.0", "$(TargetFramework.StartsWith('net99.0'))", CpmWriteScope.Group)]));

        Assert.AreEqual("packageNotFound", error.Code);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_InvalidPackageIdOrVersion_IsRefused()
    {
        var before = CopyFixture("single-group.props");

        var badId = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath, [new CpmVersionChange("bad id", "1.0.0")]));
        var badVersion = await Assert.ThrowsExactlyAsync<WorkspaceException>(() =>
            CpmWriter.UpdateVersionsAsync(propsPath, [new CpmVersionChange("Newtonsoft.Json", "not-a-version")]));

        Assert.AreEqual("invalidPackageId", badId.Code);
        Assert.AreEqual("invalidVersion", badVersion.Code);
        Assert.AreEqual(before, File.ReadAllText(propsPath));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task UpdateVersionsAsync_AppliesEveryChangeInOneWrite()
    {
        CopyFixture("single-group.props");

        await CpmWriter.UpdateVersionsAsync(propsPath, [
            new CpmVersionChange("Newtonsoft.Json", "13.0.4"),
            new CpmVersionChange("Serilog", "2.12.0"),
        ]);

        var content = File.ReadAllText(propsPath);
        StringAssert.Contains(content, "Include=\"Newtonsoft.Json\" Version=\"13.0.4\"");
        StringAssert.Contains(content, "Include=\"Serilog\" Version=\"2.12.0\"");
    }

    private async Task AssertGoldenAsync(string fixture, IReadOnlyList<CpmVersionChange> changes, string golden)
    {
        CopyFixture(fixture);

        await CpmWriter.UpdateVersionsAsync(propsPath, changes);

        Assert.AreEqual(File.ReadAllText(GoldenPath(golden)), File.ReadAllText(propsPath));
    }

    private string CopyFixture(string fixture)
    {
        var content = TestPaths.ReadFixture("cpm", fixture);
        File.WriteAllText(propsPath, content);
        return content;
    }

    private static string GoldenPath(string name) => TestPaths.Fixture("cpm", "expected", name);
}
