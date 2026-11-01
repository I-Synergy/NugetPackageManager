// File: tests/NugetPackageManager.Core.Tests/Diagnostics/RestoreOutputTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `restore-diagnostics.test.ts`.

using NugetPackageManager.Core.Diagnostics;

namespace NugetPackageManager.Core.Tests.Diagnostics;

[TestClass]
public class RestoreOutputTests
{
    private static readonly string[] expectedRanges = [">= 11.0.0-rc.3.26522.148", "= 11.0.0-rc.2.26504.105"];

    private const string Nu1107Output =
        "C:\\Projects\\App\\Sample.EventSourcing.Api.csproj : error NU1107: Version conflict detected for Microsoft.EntityFrameworkCore.Relational. Install/reference Microsoft.EntityFrameworkCore.Relational 11.0.0-rc.3.26522.148 directly to project Sample.EventSourcing.Api to resolve this issue. \n" +
        "C:\\Projects\\App\\Sample.EventSourcing.Api.csproj :  Sample.EventSourcing.Api -> I-Synergy.Framework.EventSourcing.EntityFramework -> Microsoft.EntityFrameworkCore.Relational (>= 11.0.0-rc.3.26522.148) \n" +
        "C:\\Projects\\App\\Sample.EventSourcing.Api.csproj :  Sample.EventSourcing.Api -> Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2 -> Microsoft.EntityFrameworkCore.Relational (= 11.0.0-rc.2.26504.105).";

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Nu1107WithPrefix_KeepsTheChain()
    {
        // Act
        var conflicts = RestoreOutput.Parse(Nu1107Output);

        // Assert
        Assert.AreEqual(1, conflicts.Count);
        var conflict = conflicts[0];
        Assert.AreEqual("NU1107", conflict.Code);
        Assert.AreEqual("Microsoft.EntityFrameworkCore.Relational", conflict.PackageId);
        Assert.AreEqual("11.0.0-rc.3.26522.148", conflict.SuggestedVersion);
        Assert.AreEqual("Sample.EventSourcing.Api", conflict.ProjectName);
        Assert.AreEqual(2, conflict.Constraints.Count);
        CollectionAssert.AreEqual(
            expectedRanges,
            conflict.Constraints.Select(constraint => constraint.Range).ToArray());
        StringAssert.Contains(
            conflict.Constraints[1].Chain,
            "Npgsql.EntityFrameworkCore.PostgreSQL");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Nu1107WithoutTheProjectPrefix_KeepsTheChain()
    {
        // Arrange
        var unprefixed = string.Join(
            "\n",
            Nu1107Output.Split('\n').Select(line => line[(line.IndexOf(" : ", StringComparison.Ordinal) + 3)..]));

        // Act
        var conflicts = RestoreOutput.Parse(unprefixed);

        // Assert
        Assert.AreEqual(1, conflicts.Count);
        Assert.AreEqual(2, conflicts[0].Constraints.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Nu1605_KeepsTheRequiredVersion()
    {
        // Act
        var conflicts = RestoreOutput.Parse(
            "error NU1605: Detected package downgrade: Newtonsoft.Json from 13.0.3 to 13.0.1. Reference the package directly from the project to select a different version.");

        // Assert
        Assert.AreEqual(1, conflicts.Count);
        Assert.AreEqual("NU1605", conflicts[0].Code);
        Assert.AreEqual("Newtonsoft.Json", conflicts[0].PackageId);
        Assert.AreEqual("13.0.3", conflicts[0].SuggestedVersion);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_Nu1102_ReportsTheUnresolvablePackage()
    {
        // Act
        var conflicts = RestoreOutput.Parse(
            "error NU1102: Unable to find package Foo.Bar with version (>= 9.0.0)");

        // Assert
        Assert.AreEqual(1, conflicts.Count);
        Assert.AreEqual("Foo.Bar", conflicts[0].PackageId);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_MultipleConflicts_AreIndependent()
    {
        // Arrange
        const string output =
            "error NU1107: Version conflict detected for Pkg.A. Install/reference Pkg.A 2.0.0 directly to project App to resolve this issue.\n" +
            " App -> Provider 1.0.0.0 -> Pkg.A (= 1.0.0)\n" +
            "error NU1107: Version conflict detected for Pkg.B. Install/reference Pkg.B 3.0.0 directly to project App to resolve this issue.\n" +
            " App -> Other 1.0.0 -> Pkg.B (= 2.0.0)";

        // Act
        var conflicts = RestoreOutput.Parse(output);

        // Assert
        Assert.AreEqual(2, conflicts.Count);
        Assert.AreEqual("Pkg.A", conflicts[0].PackageId);
        Assert.AreEqual("Pkg.B", conflicts[1].PackageId);
        Assert.AreEqual(1, conflicts[1].Constraints.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Parse_SuccessfulRestore_ReturnsNothing()
    {
        // Act
        var conflicts = RestoreOutput.Parse(
            "Determining projects to restore...\nAll projects are up-to-date for restore.");

        // Assert
        Assert.AreEqual(0, conflicts.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Format_NamesThePackageAndBothConstraints()
    {
        // Act
        var text = RestoreOutput.Format(RestoreOutput.Parse(Nu1107Output));

        // Assert
        StringAssert.Contains(text, "NU1107 Microsoft.EntityFrameworkCore.Relational");
        StringAssert.Contains(text, "Npgsql.EntityFrameworkCore.PostgreSQL 11.0.0-rc.2");
        StringAssert.Contains(text, ">= 11.0.0-rc.3.26522.148");
        StringAssert.Contains(text, "= 11.0.0-rc.2.26504.105");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Summarize_UsesParsedConflictsWhenAvailable()
    {
        // Act
        var summary = RestoreOutput.Summarize(Nu1107Output);

        // Assert
        Assert.IsNotNull(summary);
        StringAssert.Contains(summary, "NU1107");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Summarize_FallsBackToErrorLines()
    {
        // Act
        var summary = RestoreOutput.Summarize(
            "C:\\ws\\App.csproj : error MSB4025: The project file could not be loaded.\nBuild FAILED.");

        // Assert
        Assert.AreEqual("error MSB4025: The project file could not be loaded.", summary);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Summarize_FallsBackToTheTail()
    {
        Assert.AreEqual("line one | line two", RestoreOutput.Summarize("line one\nline two"));
        Assert.IsNull(RestoreOutput.Summarize(""));
    }
}
