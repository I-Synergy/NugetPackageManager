// File: tests/NugetPackageManager.Core.Workspace.Tests/WorkspaceModelServiceTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `parseProjectWithCpmAsync` in host-api.ts: CPM lookup, flat version map, conditional
// resolutions and the `CpmEnabled` / `TargetFrameworks` / `TfmSource` fields.

using NugetPackageManager.Core.Workspace.Cpm;
using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the workspace.")]
public class WorkspaceModelServiceTests
{
    private static readonly string[] net10Only = ["net10.0"];
    private static readonly string[] net10AndNet11 = ["net10.0", "net11.0"];

    private TemporaryDirectory? workspace;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("workspace-model");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ProjectsWithoutCpm_AreParsedAndSorted()
    {
        // Arrange
        var beta = WriteProject("Beta", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Serilog" Version="3.1.1" />
              </ItemGroup>
            </Project>
            """);
        var alpha = WriteProject("Alpha", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([beta, alpha], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(2, projects.Count);
        Assert.AreEqual("Alpha.csproj", projects[0].Name);
        Assert.AreEqual("Beta.csproj", projects[1].Name);
        Assert.IsFalse(projects[0].CpmEnabled);
        Assert.AreEqual("13.0.3", projects[0].Packages[0].Version);
        Assert.AreEqual("project", projects[0].Packages[0].VersionSource);
        Assert.AreEqual("xml", projects[0].TfmSource);
        Assert.AreEqual(0, projects[0].TargetFrameworks?.Count ?? 0);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CentralPackages_ResolvesVersionsAndFlag()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Central", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var parsed = projects[0];
        Assert.IsTrue(parsed.CpmEnabled);
        Assert.AreEqual("13.0.3", parsed.Packages[0].Version);
        Assert.AreEqual("central", parsed.Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CpmPropsChangedOnDisk_RefreshesCachedVersion()
    {
        // Regression: the sidecar used to keep serving the props map it parsed at process start,
        // so the Installed tab showed stale versions after an external edit (or the extension's
        // own batch update). The cache now stamps the file's last-write time and length.
        // Arrange
        var propsPath = workspace!.Combine("Directory.Packages.props");
        File.WriteAllText(propsPath, """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Refresh", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act — first scan warms the cache.
        var before = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.AreEqual("13.0.3", before[0].Packages[0].Version);
        Assert.AreEqual("central", before[0].Packages[0].VersionSource);

        // Overwrite with a same-length version so only the timestamp can distinguish the two, and
        // move the timestamp forward explicitly to dodge filesystem granularity.
        File.WriteAllText(propsPath, """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="14.0.0" />
              </ItemGroup>
            </Project>
            """);
        File.SetLastWriteTimeUtc(propsPath, DateTime.UtcNow.AddMinutes(1));

        // Act — same service instance, cached props map must be refreshed.
        var after = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.AreEqual("14.0.0", after[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ConditionalCpm_ProducesResolutionsPerFramework()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Pkg.Shared" Version="10.0.1" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
                <PackageVersion Include="Pkg.Shared" Version="11.0.0" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Multi", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var package = projects[0].Packages[0];
        Assert.IsNotNull(package.CpmResolutions);
        Assert.AreEqual(2, package.CpmResolutions.Count);
        Assert.AreEqual("10.0.1", package.CpmResolutions[0].Version);
        Assert.AreEqual("net10.0", package.CpmResolutions[0].Tfm);
        Assert.AreEqual("11.0.0", package.CpmResolutions[1].Version);
        Assert.AreEqual("net10.0", package.CpmFramework);
        // Two version lines disagree, so `Version` keeps the flat CPM value (first conditional
        // occurrence) instead of being collapsed to one of them — same as the TypeScript path.
        Assert.AreEqual("10.0.1", package.Version);
        Assert.AreEqual("net10.0;net11.0", string.Join(';', projects[0].TargetFrameworks!));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ConditionMatchesSingleVersion_FillsVersion()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup Condition="$(TargetFramework.StartsWith('net1'))">
                <PackageVersion Include="Pkg.Shared" Version="9.9.9" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Single", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(1, projects[0].Packages[0].CpmResolutions!.Count);
        Assert.AreEqual("9.9.9", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void BuildFlatMap_UnconditionalWinsOverConditional()
    {
        // Arrange
        var unconditional = new Dictionary<string, string> { ["A"] = "1.0.0" };
        var conditional = new List<CpmFrameworkEntry>
        {
            new()
            {
                Condition = "$(TargetFramework) == 'net10.0'",
                Framework = "net10.0",
                Versions = new Dictionary<string, string> { ["A"] = "2.0.0", ["B"] = "3.0.0" },
                Order = 1,
            },
        };
        var map = new CpmPackageMap(unconditional, conditional, true);

        // Act
        var flat = WorkspaceModelService.BuildFlatMap(map);

        // Assert
        Assert.AreEqual("1.0.0", flat["A"]);
        Assert.AreEqual("3.0.0", flat["B"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_UnreadableProject_IsSkipped()
    {
        // Arrange
        var broken = workspace!.Combine("Broken.csproj");
        File.WriteAllText(broken, "<Project><unclosed>");

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([broken], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(0, projects.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CpmFixtures_MatchTheKnownFrameworkLines()
    {
        // The fixtures the TypeScript suite used to assert against, now checked where the
        // resolution logic lives.
        File.Copy(
            TestPaths.Fixture("cpm", "negated-positive.props"),
            workspace!.Combine("Directory.Packages.props"));

        var projects = new List<string>();
        foreach (var fixture in new[] { "net10", "net11", "multi", "net10-windows" })
        {
            var target = workspace!.Combine($"{fixture}.csproj");
            File.Copy(TestPaths.Fixture("projects", fixture, $"{fixture}.csproj"), target);
            projects.Add(target);
        }

        using var service = new WorkspaceModelService();

        // Act
        var models = await service.GetProjectsAsync(projects, [], CancellationToken.None);

        // Assert
        var byName = models.ToDictionary(project => project.Name, StringComparer.OrdinalIgnoreCase);

        var net10 = byName["net10.csproj"];
        CollectionAssert.AreEqual(net10Only, net10.TargetFrameworks!.ToArray());
        var loggingNet10 = net10.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual(1, loggingNet10.CpmResolutions!.Count);
        Assert.AreEqual("net10.0", loggingNet10.CpmResolutions[0].Tfm);
        Assert.AreEqual("10.0.13", loggingNet10.CpmResolutions[0].Version);
        Assert.AreEqual("not net11.0", loggingNet10.CpmResolutions[0].ConditionLabel);
        Assert.AreEqual("not net11.0", loggingNet10.CpmFramework);

        var net11 = byName["net11.csproj"];
        var loggingNet11 = net11.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual("net11.0", loggingNet11.CpmResolutions![0].Tfm);
        Assert.AreEqual("11.0.0-rc.2.26504.105", loggingNet11.CpmResolutions[0].Version);

        var multi = byName["multi.csproj"];
        CollectionAssert.AreEqual(net10AndNet11, multi.TargetFrameworks!.ToArray());
        var loggingMulti = multi.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual(2, loggingMulti.CpmResolutions!.Count);
        Assert.AreEqual("10.0.13", loggingMulti.CpmResolutions.Single(r => r.Tfm == "net10.0").Version);
        Assert.AreEqual("11.0.0-rc.2.26504.105", loggingMulti.CpmResolutions.Single(r => r.Tfm == "net11.0").Version);

        var windows = byName["net10-windows.csproj"];
        var loggingWindows = windows.Packages.Single(package => package.Id == "Microsoft.Extensions.Logging");
        Assert.AreEqual("net10.0-windows10.0.26100.0", loggingWindows.CpmResolutions![0].Tfm);
        Assert.AreEqual("10.0.13", loggingWindows.CpmResolutions[0].Version);

        var shared = multi.Packages.Single(package => package.Id == "Shared.Library");
        Assert.AreEqual(1, shared.CpmResolutions!.Count);
        Assert.AreEqual(string.Empty, shared.CpmResolutions[0].Tfm);
        Assert.AreEqual("1.0.0", shared.CpmResolutions[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_UnconditionalPropertyVersion_ResolvesToEffectiveValue()
    {
        // Arrange — a `$(FooBarVersion)` central version must reach the model evaluated.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Unconditional", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation(("Foo.Bar", "1.2.3")));

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var package = projects[0].Packages[0];
        Assert.AreEqual("1.2.3", package.Version);
        Assert.AreEqual("central", package.VersionSource);
        Assert.IsTrue(projects[0].CpmEnabled);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ConditionalPropertyVersions_ProducesRowPerTfmWithEvaluatedValues()
    {
        // Arrange — a property-based conditional group per framework.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <Net10Version>10.0.1</Net10Version>
                <Net11Version>11.0.0</Net11Version>
              </PropertyGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net10Version)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net11Version)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("ConditionalProps", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, tfm) => tfm switch
        {
            "net10.0" => Evaluation(("Pkg.Shared", "10.0.1")),
            "net11.0" => Evaluation(("Pkg.Shared", "11.0.0")),
            _ => Evaluation(),
        });

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert — one row per TFM, evaluated value, existing condition label.
        var package = projects[0].Packages[0];
        Assert.IsNotNull(package.CpmResolutions);
        Assert.AreEqual(2, package.CpmResolutions.Count);
        var net10 = package.CpmResolutions.Single(row => row.Tfm == "net10.0");
        var net11 = package.CpmResolutions.Single(row => row.Tfm == "net11.0");
        Assert.AreEqual("10.0.1", net10.Version);
        Assert.AreEqual("11.0.0", net11.Version);
        Assert.AreEqual("net10.0", net10.ConditionLabel);
        Assert.AreEqual("net11.0", net11.ConditionLabel);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ApplyResolutions_MultipleResolutionsAndEmptyFlatVersion_IsNotSkipped()
    {
        // Arrange — the mandatory multi-TFM regression: a package with framework-scoped versions
        // has no single flat `Version`, yet must keep every resolution.
        var unconditional = new Dictionary<string, string>(StringComparer.Ordinal);
        var conditional = new List<CpmFrameworkEntry>
        {
            new()
            {
                Condition = "'$(TargetFramework)' == 'net10.0'",
                Framework = "net10.0",
                Versions = new Dictionary<string, string>(StringComparer.Ordinal) { ["Pkg.Shared"] = "10.0.1" },
                Order = 1,
            },
            new()
            {
                Condition = "'$(TargetFramework)' == 'net11.0'",
                Framework = "net11.0",
                Versions = new Dictionary<string, string>(StringComparer.Ordinal) { ["Pkg.Shared"] = "11.0.0" },
                Order = 2,
            },
        };
        var map = new CpmPackageMap(unconditional, conditional, true);
        var project = new Models.ProjectModel
        {
            Name = "Multi.csproj",
            Path = "Multi.csproj",
            CpmEnabled = true,
            Packages = [new Models.ProjectPackageModel { Id = "Pkg.Shared", Version = string.Empty, IsPinned = false, VersionSource = "central" }],
        };

        // Act
        var result = WorkspaceModelService.ApplyResolutions(project, map, ["net10.0", "net11.0"]);

        // Assert
        var package = result.Packages[0];
        Assert.IsNotNull(package.CpmResolutions);
        Assert.AreEqual(2, package.CpmResolutions.Count);
        Assert.AreEqual(string.Empty, package.Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_EvaluatorReturnsNull_KeepsRawPropertyVersion()
    {
        // Arrange
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Fallback", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => null);

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert — evaluation failure leaves the raw XML value.
        Assert.AreEqual("$(FooBarVersion)", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_NoPropertyReference_NeverInvokesEvaluator()
    {
        // Arrange — literal versions must not pay for a `dotnet msbuild` call.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Newtonsoft.Json" Version="13.0.3" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Literal", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Newtonsoft.Json" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation());

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.AreEqual(0, evaluator.Calls);
        Assert.AreEqual("13.0.3", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_NonCpmPropertyReference_ResolvesWhileLiteralSiblingIsUntouched()
    {
        // Arrange — non-CPM project with one property-based and one literal reference.
        var project = WriteProject("NonCpm", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Foo.Bar" Version="$(FooBarVersion)" />
                <PackageReference Include="Serilog" Version="3.1.1" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, tfm) => tfm is null
            ? EvaluationWithReferences(("Foo.Bar", "1.2.3"))
            : Evaluation());

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var packages = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3", packages["Foo.Bar"].Version);
        Assert.AreEqual("project", packages["Foo.Bar"].VersionSource);
        Assert.AreEqual("3.1.1", packages["Serilog"].Version);
        Assert.IsFalse(projects[0].CpmEnabled);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PropertyVersionFixture_ResolvesBothUnconditionalAndConditional()
    {
        // The checked-in property-based fixture, reached through TestPaths.Fixture, resolved
        // through a fake evaluator (no `dotnet msbuild` spawn).
        File.Copy(
            TestPaths.Fixture("cpm", "property-versions.props"),
            workspace!.Combine("Directory.Packages.props"));

        var project = WriteProject("PropertyFixture", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
                <PackageReference Include="Microsoft.Extensions.Logging" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, tfm) => tfm switch
        {
            "net10.0" => Evaluation(("Microsoft.Extensions.Logging", "10.0.13")),
            "net11.0" => Evaluation(("Microsoft.Extensions.Logging", "11.0.0-rc.2.26504.105")),
            _ => Evaluation(("Foo.Bar", "1.2.3")),
        });

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        var byId = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3", byId["Foo.Bar"].Version);
        Assert.AreEqual(
            "10.0.13",
            byId["Microsoft.Extensions.Logging"].CpmResolutions!.Single(row => row.Tfm == "net10.0").Version);
        Assert.AreEqual(
            "11.0.0-rc.2.26504.105",
            byId["Microsoft.Extensions.Logging"].CpmResolutions!.Single(row => row.Tfm == "net11.0").Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PropertyWithSuffix_UsesEvaluatedValueAndKeepsUnresolvedRaw()
    {
        // Arrange — one version embeds the property in surrounding text and evaluates; the second
        // package is missing from the evaluation, so its raw expression has to survive.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
                <MissingVersion>9.9.9</MissingVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)-beta" />
                <PackageVersion Include="Missing.Package" Version="$(MissingVersion)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Suffix", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
                <PackageReference Include="Missing.Package" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation(("Foo.Bar", "1.2.3-beta")));

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert — the whole expression is replaced; a package absent from the evaluation keeps
        // its raw XML value.
        var packages = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3-beta", packages["Foo.Bar"].Version);
        Assert.AreEqual("$(MissingVersion)", packages["Missing.Package"].Version);
    }

    private static CpmEvaluation Evaluation(
        params (string Id, string Version)[] central) =>
        new()
        {
            CentralVersions = central.ToDictionary(entry => entry.Id, entry => entry.Version, StringComparer.OrdinalIgnoreCase),
            PackageReferences = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
        };

    private static CpmEvaluation EvaluationWithReferences(
        params (string Id, string Version)[] packageReferences) =>
        new()
        {
            CentralVersions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase),
            PackageReferences = packageReferences.ToDictionary(entry => entry.Id, entry => entry.Version, StringComparer.OrdinalIgnoreCase),
        };

    private sealed class FakeCpmEvaluator(Func<string, string?, CpmEvaluation?> factory) : ICpmEvaluator
    {
        public int Calls { get; private set; }

        public Task<CpmEvaluation?> EvaluateAsync(
            string projectPath,
            string? targetFramework,
            CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(factory(projectPath, targetFramework));
        }
    }

    private string WriteProject(string name, string content) =>
        workspace!.WriteFile($"{name}.csproj", content);
}
