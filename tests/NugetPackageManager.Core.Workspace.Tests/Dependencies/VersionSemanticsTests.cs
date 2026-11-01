// File: tests/NugetPackageManager.Core.Workspace.Tests/Dependencies/VersionSemanticsTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Pins the NuGet rules the ported dependency algorithms rely on, including the range
// spellings the TypeScript implementation accepted.

using NugetPackageManager.Core.Workspace.Dependencies;

namespace NugetPackageManager.Core.Workspace.Tests.Dependencies;

[TestClass]
public class VersionSemanticsTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void Compare_FollowsSemVerPrereleaseOrdering()
    {
        Assert.AreEqual(0, VersionSemantics.Compare("1.0.0", "1.0.0"));
        Assert.IsTrue(VersionSemantics.Compare("1.0.0-beta", "1.0.0") < 0);
        Assert.IsTrue(VersionSemantics.Compare("11.0.0-rc.2", "11.0.0-rc.10") < 0);
        Assert.IsTrue(VersionSemantics.Compare("2.0.0", "1.9.9") > 0);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void RangeLowerBound_ReadsNuGetRanges()
    {
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound("[1.2.3, )"));
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound("(1.2.3, 2.0.0]"));
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound("[1.2.3]"));
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound("1.2.3"));
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound(">= 1.2.3"));
        Assert.AreEqual("1.2.3", VersionSemantics.RangeLowerBound(">1.2.3"));
        Assert.IsNull(VersionSemantics.RangeLowerBound("(, 2.0.0]"));
        Assert.IsNull(VersionSemantics.RangeLowerBound("*"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Satisfies_HandlesIntervalsMinimumsAndFloats()
    {
        Assert.IsTrue(VersionSemantics.Satisfies("1.5.0", "[1.0.0, 2.0.0)"));
        Assert.IsFalse(VersionSemantics.Satisfies("2.0.0", "[1.0.0, 2.0.0)"));
        Assert.IsTrue(VersionSemantics.Satisfies("2.0.0", "[2.0.0]"));
        Assert.IsFalse(VersionSemantics.Satisfies("2.0.1", "[2.0.0]"));

        // A bare version in a nuspec range means "at least".
        Assert.IsTrue(VersionSemantics.Satisfies("2.0.0", "1.0.0"));
        Assert.IsFalse(VersionSemantics.Satisfies("0.9.0", "1.0.0"));

        // Floating ranges only match their prefix.
        Assert.IsTrue(VersionSemantics.Satisfies("1.5.0", "1.*"));
        Assert.IsFalse(VersionSemantics.Satisfies("2.0.0", "1.*"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Satisfies_EmptyOrUnparseableRange_IsUnconstrained()
    {
        Assert.IsTrue(VersionSemantics.Satisfies("1.0.0", ""));
        Assert.IsTrue(VersionSemantics.Satisfies("1.0.0", "not a range"));
        Assert.IsTrue(VersionSemantics.Satisfies("1.0.0", "*"));
    }
}
