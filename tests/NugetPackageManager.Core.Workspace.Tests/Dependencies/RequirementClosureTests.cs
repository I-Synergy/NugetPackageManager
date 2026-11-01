// File: tests/NugetPackageManager.Core.Workspace.Tests/Dependencies/RequirementClosureTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `requirement-closure.test.ts`. The dependency metadata is supplied by a fake
// lookup, exactly as the TypeScript suite did.

using NugetPackageManager.Core.Workspace.Dependencies;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Tests.Dependencies;

[TestClass]
public class RequirementClosureTests
{
    private static readonly string[] expectedPackageIds = ["B", "C"];
    private static readonly string[] expectedRequiredBy = ["A", "B"];
    private static readonly string[] expectedPerTfm = ["net10.0:2.0.0", "net11.0:3.0.0"];
    private static readonly string[] expectedDependsOn = ["microsoft.extensions.hosting"];
    private static readonly string[] twoTfms = ["net10.0", "net11.0"];

    private static DependencyLookup Provider(Dictionary<string, ClosureDependency[]> dependencies) =>
        (id, version, tfm, _) => Task.FromResult(
            dependencies.TryGetValue($"{id}@{version}|{tfm}", out var value)
                ? (IReadOnlyList<ClosureDependency>?)value
                : null);

    private static Task<ClosureResult> ComputeAsync(
        Dictionary<string, ClosureDependency[]> dependencies,
        Dictionary<string, string> effective,
        string[]? tfms = null,
        int maxInspected = Constants.DefaultMaxInspected)
    {
        var selected = new[] { new SelectedPackage("A", "2.0.0") };
        var frameworks = tfms ?? ["net10.0"];

        return RequirementClosure.ComputeAsync(
            selected,
            frameworks,
            effective,
            Provider(dependencies),
            (_, _) => true,
            maxInspected,
            CancellationToken.None);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_DirectRequirementBelowTheResolvedVersion_IsAConflict()
    {
        // Act
        var result = await ComputeAsync(
            new()
            {
                ["A@2.0.0|net10.0"] = [new ClosureDependency("B", "[2.0.0, )")],
            },
            new() { ["b"] = "1.0.0" });

        // Assert
        Assert.AreEqual(1, result.Conflicts.Count);
        var conflict = result.Conflicts[0];
        Assert.AreEqual("B", conflict.PackageId);
        Assert.AreEqual("A", conflict.RequiredBy);
        Assert.AreEqual("2.0.0", conflict.RequiredByVersion);
        Assert.AreEqual("[2.0.0, )", conflict.Range);
        Assert.AreEqual("2.0.0", conflict.RequiredVersion);
        Assert.AreEqual("net10.0", conflict.Tfm);
        Assert.AreEqual("2.0.0", result.Planned["b"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_FollowsTheClosureThroughARequiredPackage()
    {
        // Act
        var result = await ComputeAsync(
            new()
            {
                ["A@2.0.0|net10.0"] = [new ClosureDependency("B", "[2.0.0, )")],
                ["B@2.0.0|net10.0"] = [new ClosureDependency("C", "[3.0.0, )")],
            },
            new() { ["b"] = "1.0.0", ["c"] = "1.0.0" });

        // Assert
        CollectionAssert.AreEqual(
            expectedPackageIds,
            result.Conflicts.Select(conflict => conflict.PackageId).ToArray());
        CollectionAssert.AreEqual(
            expectedRequiredBy,
            result.Conflicts.Select(conflict => conflict.RequiredBy).ToArray());
        Assert.AreEqual("3.0.0", result.Planned["c"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_RequirementTheGraphAlreadySatisfies_IsIgnored()
    {
        // Act
        var result = await ComputeAsync(
            new()
            {
                ["A@2.0.0|net10.0"] = [new ClosureDependency("B", "[2.0.0, )")],
            },
            new() { ["b"] = "2.5.0" });

        // Assert
        Assert.AreEqual(0, result.Conflicts.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_RangeWithoutALowerBound_IsIgnored()
    {
        // Act
        var result = await ComputeAsync(
            new()
            {
                ["A@2.0.0|net10.0"] = [new ClosureDependency("B", "(, 2.0.0]")],
            },
            new() { ["b"] = "1.0.0" });

        // Assert
        Assert.AreEqual(0, result.Conflicts.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_KeepsPerTfmRequirementsApart()
    {
        // Act
        var result = await ComputeAsync(
            new()
            {
                ["A@2.0.0|net10.0"] = [new ClosureDependency("B", "[2.0.0, )")],
                ["A@2.0.0|net11.0"] = [new ClosureDependency("B", "[3.0.0, )")],
            },
            new() { ["b"] = "1.0.0" },
            twoTfms);

        // Assert
        CollectionAssert.AreEqual(
            expectedPerTfm,
            result.Conflicts.Select(conflict => $"{conflict.Tfm}:{conflict.RequiredVersion}").ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task Compute_StopsAtTheInspectionBudget()
    {
        // Arrange
        var dependencies = new Dictionary<string, ClosureDependency[]>();
        for (var index = 0; index < 10; index++)
        {
            dependencies[$"P{index}@1.0.0|net10.0"] =
                [new ClosureDependency($"P{index + 1}", "[1.0.0, )")];
        }

        var selected = new[] { new SelectedPackage("P0", "1.0.0") };
        string[] oneTfm = ["net10.0"];

        // Act
        var result = await RequirementClosure.ComputeAsync(
            selected,
            oneTfm,
            new Dictionary<string, string>(),
            Provider(dependencies),
            (_, _) => true,
            maxInspected: 3,
            CancellationToken.None);

        // Assert
        Assert.IsTrue(result.Conflicts.Count <= 3);
        Assert.IsTrue(result.Conflicts.Count > 0);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Order_PutsDependenciesInEarlierSteps()
    {
        // Arrange
        ClosureConflict[] conflicts =
        [
            Conflict("Globalization", "Core"),
            Conflict("Core", "Microsoft.Extensions.Hosting"),
        ];

        // Act
        var order = RequirementClosure.Order(conflicts);

        // Assert
        Assert.AreEqual(0, order["microsoft.extensions.hosting"].Order);
        Assert.AreEqual(1, order["core"].Order);
        Assert.AreEqual(2, order["globalization"].Order);
        CollectionAssert.AreEqual(
            expectedDependsOn,
            order["core"].DependsOn.ToArray());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Order_ToleratesACycle()
    {
        // Arrange
        ClosureConflict[] conflicts =
        [
            Conflict("A", "B"),
            Conflict("B", "A"),
        ];

        // Act
        var order = RequirementClosure.Order(conflicts);

        // Assert
        Assert.IsTrue(double.IsFinite(order["a"].Order));
        Assert.IsTrue(double.IsFinite(order["b"].Order));
    }

    private static ClosureConflict Conflict(string requiredBy, string packageId) =>
        new()
        {
            PackageId = packageId,
            RequiredBy = requiredBy,
            RequiredByVersion = "1.0.0",
            Range = "[1.0.0, )",
            RequiredVersion = "1.0.0",
            Tfm = "net10.0",
        };
}
