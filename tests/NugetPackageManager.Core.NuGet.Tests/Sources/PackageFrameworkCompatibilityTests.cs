// File: tests/NugetPackageManager.Core.NuGet.Tests/Sources/PackageFrameworkCompatibilityTests.cs
// Traces: framework-compatible-updates — a candidate is only offered when the version declares
// a framework the row can consume.

using NuGet.Frameworks;
using NugetPackageManager.Core.NuGet.Sources;

namespace NugetPackageManager.Core.NuGet.Tests.Sources;

[TestClass]
public class PackageFrameworkCompatibilityTests
{
    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_ProjectNet10AgainstDeclaredNet11_IsIncompatible()
    {
        var declared = new[] { NuGetFramework.ParseFolder("net11.0") };
        var project = Parse("net10.0");

        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", declared, project);

        Assert.IsTrue(result.Known);
        Assert.IsFalse(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_ProjectNet10AgainstNetStandard20_IsCompatible()
    {
        var declared = new[] { NuGetFramework.ParseFolder("netstandard2.0") };
        var project = Parse("net10.0");

        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", declared, project);

        Assert.IsTrue(result.Known);
        Assert.IsTrue(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_ProjectAndroid36AgainstDeclaredAndroid_IsCompatible()
    {
        var declared = new[] { NuGetFramework.ParseFolder("net10.0-android") };
        var project = Parse("net10.0-android36.0");

        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", declared, project);

        Assert.IsTrue(result.Known);
        Assert.IsTrue(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_NoDeclaredFrameworks_IsUnknown()
    {
        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", [], Parse("net10.0"));

        Assert.IsFalse(result.Known);
        Assert.IsTrue(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_AnyFrameworkGroup_IsCompatible()
    {
        var declared = new[] { NuGetFramework.AnyFramework };
        var project = Parse("net10.0");

        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", declared, project);

        Assert.IsTrue(result.Known);
        Assert.IsTrue(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ParseProjectFrameworks_UnparseableName_ReturnsNull()
    {
        var parsed = PackageFrameworkCompatibility.ParseProjectFrameworks(["not net11.0"]);

        Assert.IsNull(parsed);

        var result = PackageFrameworkCompatibility.Evaluate(
            "12.0.0",
            [NuGetFramework.ParseFolder("net11.0")],
            parsed);

        Assert.IsFalse(result.Known);
        Assert.IsTrue(result.Compatible);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Evaluate_MultipleProjectFrameworks_OneUnsatisfied_IsIncompatible()
    {
        var declared = new[] { NuGetFramework.ParseFolder("net10.0") };
        var project = Parse("net10.0", "net48");

        var result = PackageFrameworkCompatibility.Evaluate("12.0.0", declared, project);

        Assert.IsTrue(result.Known);
        Assert.IsFalse(result.Compatible);
    }

    private static IReadOnlyList<NuGetFramework>? Parse(params string[] frameworks) =>
        PackageFrameworkCompatibility.ParseProjectFrameworks(frameworks);
}
