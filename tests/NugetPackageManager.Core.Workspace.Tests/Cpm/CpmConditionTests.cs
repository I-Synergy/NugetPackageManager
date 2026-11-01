// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmConditionTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `cpm-condition.test.ts` case for case: the TypeScript suite is the specification
// for this port, so a divergence here means the port is wrong.

using NugetPackageManager.Core.Workspace.Cpm;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
public class CpmConditionTests
{
    private static readonly Dictionary<string, string> net10 = new() { ["TargetFramework"] = "net10.0" };
    private static readonly Dictionary<string, string> net11 = new() { ["TargetFramework"] = "net11.0" };
    private static readonly Dictionary<string, string> net10Windows =
        new() { ["TargetFramework"] = "net10.0-windows10.0.26100.0" };

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_PositiveStartsWith_MatchesOnlyThatTfm()
    {
        const string condition = "$(TargetFramework.StartsWith('net11.0'))";

        Assert.AreEqual(true, CpmCondition.Evaluate(condition, net11));
        Assert.AreEqual(false, CpmCondition.Evaluate(condition, net10));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_NegatedStartsWith_InvertsTheResult()
    {
        const string condition = "!$(TargetFramework.StartsWith('net11.0'))";

        Assert.AreEqual(true, CpmCondition.Evaluate(condition, net10));
        Assert.AreEqual(false, CpmCondition.Evaluate(condition, net11));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_PlatformSpecificTfm_StillMatchesItsBaseTfm()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate("$(TargetFramework.StartsWith('net10.0'))", net10Windows));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_EndsWithAndContains()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate("$(TargetFramework.EndsWith('26100.0'))", net10Windows));
        Assert.AreEqual(true, CpmCondition.Evaluate("$(TargetFramework.Contains('-windows'))", net10Windows));
        Assert.AreEqual(false, CpmCondition.Evaluate("$(TargetFramework.Contains('-android'))", net10Windows));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_EqualityAndInequality()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate("'$(TargetFramework)' == 'net10.0'", net10));
        Assert.AreEqual(false, CpmCondition.Evaluate("'$(TargetFramework)' != 'net10.0'", net10));
        Assert.AreEqual(true, CpmCondition.Evaluate("'$(TargetFramework)' != 'net10.0'", net11));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_AndOrWithParentheses()
    {
        const string condition =
            "('$(TargetFramework)' == 'net10.0' Or '$(TargetFramework)' == 'net11.0') And $(TargetFramework.StartsWith('net'))";

        Assert.AreEqual(true, CpmCondition.Evaluate(condition, net10));
        Assert.AreEqual(
            false,
            CpmCondition.Evaluate(condition, new Dictionary<string, string> { ["TargetFramework"] = "netstandard2.0" }));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_NegatedComparison()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate("!('$(TargetFramework)' == 'net11.0')", net10));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_UnknownProperty_IsUnknown()
    {
        Assert.IsNull(CpmCondition.Evaluate("$(SomeOtherProperty.StartsWith('x'))", net10));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_MalformedCondition_IsUnknown()
    {
        Assert.IsNull(CpmCondition.Evaluate("$(TargetFramework.StartsWith(", net10));
        Assert.IsNull(CpmCondition.Evaluate("And", net10));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_PropertyOnlyCondition_IsReadAsBoolean()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate("$(Enabled)", new Dictionary<string, string> { ["Enabled"] = "true" }));
        Assert.AreEqual(false, CpmCondition.Evaluate("$(Enabled)", new Dictionary<string, string> { ["Enabled"] = "false" }));
        Assert.IsNull(CpmCondition.Evaluate("$(Enabled)", new Dictionary<string, string>()));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_EmptyCondition_IsAlwaysTrue()
    {
        Assert.AreEqual(true, CpmCondition.Evaluate(string.Empty, net10));
        Assert.IsNotNull(CpmCondition.Parse(string.Empty));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetLabel_PositiveAndNegatedConditions_Differ()
    {
        Assert.AreEqual("net11.0", CpmCondition.GetLabel("$(TargetFramework.StartsWith('net11.0'))"));
        Assert.AreEqual("not net11.0", CpmCondition.GetLabel("!$(TargetFramework.StartsWith('net11.0'))"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetLabel_Comparisons()
    {
        Assert.AreEqual("net9.0", CpmCondition.GetLabel("'$(TargetFramework)' == 'net9.0'"));
        Assert.AreEqual("not net9.0", CpmCondition.GetLabel("'$(TargetFramework)' != 'net9.0'"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetLabel_UnsupportedCondition_FallsBackToReadableText()
    {
        var label = CpmCondition.GetLabel("$([MSBuild]::VersionGreaterThanOrEquals('1','2'))");

        Assert.IsTrue(label.Length > 0);
        Assert.IsFalse(label.Contains("$(", StringComparison.Ordinal));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetTfmMajorVersion_ParsesNetTfms()
    {
        Assert.AreEqual(10, CpmCondition.GetTfmMajorVersion("net10.0"));
        Assert.AreEqual(11, CpmCondition.GetTfmMajorVersion("net11.0-windows"));
        Assert.AreEqual(8, CpmCondition.GetTfmMajorVersion("net8.0-android"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void GetTfmMajorVersion_NonNetTfm_IsNull()
    {
        Assert.IsNull(CpmCondition.GetTfmMajorVersion("netstandard2.0"));
        Assert.IsNull(CpmCondition.GetTfmMajorVersion("unknown"));
    }
}
