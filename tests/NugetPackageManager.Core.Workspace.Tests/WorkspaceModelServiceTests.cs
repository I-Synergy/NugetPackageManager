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
        // Arrange — a version the XML-level resolver cannot follow (a function definition), so the
        // MSBuild path is the one under test.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>$([System.String]::Copy('1.2.3'))</FooBarVersion>
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
    public async Task GetProjectsAsync_PropertyResolvableFromProps_NeverInvokesEvaluator()
    {
        // Arrange — Aspire's shape: the versions are properties, but every property is a literal in
        // the props chain. Resolving them from XML removes both the unconditional evaluation and the
        // one-per-framework evaluations, which is the whole point of the resolver.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
                <Net10Version>10.0.1</Net10Version>
                <Net11Version>11.0.0</Net11Version>
              </PropertyGroup>
            </Project>
            """);
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <Import Project="eng\Versions.props" />
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net10Version)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net11Version)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Resolved", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFrameworks>net10.0;net11.0</TargetFrameworks>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
                <PackageReference Include="Pkg.Shared" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation());

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert — no `dotnet msbuild` at all, and the literal versions are in the model.
        Assert.AreEqual(0, evaluator.Calls);
        var byId = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3", byId["Foo.Bar"].Version);
        Assert.AreEqual(
            "10.0.1",
            byId["Pkg.Shared"].CpmResolutions!.Single(row => row.Tfm == "net10.0").Version);
        Assert.AreEqual(
            "11.0.0",
            byId["Pkg.Shared"].CpmResolutions!.Single(row => row.Tfm == "net11.0").Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PropertyNotResolvableFromProps_StillInvokesEvaluator()
    {
        // Arrange — a concatenated version cannot be resolved from XML, so the MSBuild path has to
        // run exactly as it did before the resolver existed.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)-beta" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("Unresolvable", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation(("Foo.Bar", "1.2.3-beta")));

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.IsTrue(evaluator.Calls > 0, "the unresolvable map must still fall back to MSBuild.");
        Assert.AreEqual("1.2.3-beta", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PartialMap_ProjectOnResolvedIdsNeverInvokesEvaluator()
    {
        // Arrange — Phase A2: the map has one entry the props chain cannot answer
        // (`Microsoft.Signed.Wix` → an undefined property), but the project under test references
        // only resolved ids, so no `dotnet msbuild` may be spent on it.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
                <PackageVersion Include="Microsoft.Signed.Wix" Version="$(MicrosoftSignedWixVersion)" />
              </ItemGroup>
            </Project>
            """);
        var project = WriteProject("ResolvedOnly", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => Evaluation());

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert — no evaluation at all, and the resolved literal is in the model.
        Assert.AreEqual(0, evaluator.Calls);
        Assert.AreEqual("1.2.3", projects[0].Packages[0].Version);
        Assert.AreEqual("central", projects[0].Packages[0].VersionSource);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PartialMap_ProjectReferencingUnresolvedIdInvokesEvaluator()
    {
        // Arrange — same partial map, but this project references the one package whose property
        // is undefined, so it alone pays for an evaluation; its sibling stays evaluation-free.
        workspace!.WriteFile("Directory.Packages.props", """
            <Project>
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
                <PackageVersion Include="Microsoft.Signed.Wix" Version="$(MicrosoftSignedWixVersion)" />
              </ItemGroup>
            </Project>
            """);
        var resolvedOnly = WriteProject("ResolvedOnly", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
              </ItemGroup>
            </Project>
            """);
        var unresolved = WriteProject("Unresolved", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Microsoft.Signed.Wix" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((path, _) => path.EndsWith("Unresolved.csproj", StringComparison.Ordinal)
            ? Evaluation(("Microsoft.Signed.Wix", "5.0.2.0"))
            : Evaluation(("Foo.Bar", "1.2.3")));

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([resolvedOnly, unresolved], [], CancellationToken.None);

        // Assert — exactly one evaluation, for the project that needs it.
        Assert.AreEqual(1, evaluator.Calls);
        var byName = projects.ToDictionary(project => project.Name, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3", byName["ResolvedOnly.csproj"].Packages[0].Version);
        Assert.AreEqual("5.0.2.0", byName["Unresolved.csproj"].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_PartialMap_ProjectOwnPropertyVersionStillInvokesEvaluator()
    {
        // Arrange — the map resolves fully, but the project writes its own `$(…)` version, which
        // only MSBuild can expand.
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
        var project = WriteProject("ProjectExpression", """
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <SerilogVersion>3.1.1</SerilogVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageReference Include="Foo.Bar" />
                <PackageReference Include="Serilog" Version="$(SerilogVersion)" />
              </ItemGroup>
            </Project>
            """);
        var evaluator = new FakeCpmEvaluator((_, _) => EvaluationWithReferences(("Serilog", "3.1.1")));

        using var service = new WorkspaceModelService(cpmEvaluator: evaluator);

        // Act
        var projects = await service.GetProjectsAsync([project], [], CancellationToken.None);

        // Assert
        Assert.IsTrue(evaluator.Calls > 0, "a project-level `$(…)` version still needs MSBuild.");
        var byId = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3", byId["Foo.Bar"].Version);
        Assert.AreEqual("3.1.1", byId["Serilog"].Version);
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
    public async Task GetProjectsAsync_PropertyWithSuffix_UsesEvaluatedValueAndResolvesLiteralSibling()
    {
        // Arrange — one version embeds the property in surrounding text and evaluates; the second
        // package's property is a plain literal, so the XML resolver answers it without MSBuild.
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

        // Assert — the whole expression is replaced; a package whose property the props chain does
        // define (a literal) is now resolved from XML instead of borrowing the evaluation.
        var packages = projects[0].Packages.ToDictionary(package => package.Id, StringComparer.Ordinal);
        Assert.AreEqual("1.2.3-beta", packages["Foo.Bar"].Version);
        Assert.AreEqual("9.9.9", packages["Missing.Package"].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ManyProjects_ReturnsEveryProjectSortedByName()
    {
        // Arrange — 40 generated projects, deliberately written in reverse order.
        var projectPaths = new List<string>();
        for (var index = 39; index >= 0; index--)
        {
            projectPaths.Add(WriteProject($"Project{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <ItemGroup>
                    <PackageReference Include="Serilog" Version="3.1.1" />
                  </ItemGroup>
                </Project>
                """));
        }

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync(projectPaths, [], CancellationToken.None);

        // Assert — the parallel scan returns the same list, still sorted by name.
        Assert.AreEqual(40, projects.Count);
        var expected = projectPaths
            .Select(path => Path.GetFileName(path))
            .Order(StringComparer.OrdinalIgnoreCase)
            .ToList();
        CollectionAssert.AreEqual(expected, projects.Select(project => project.Name).ToList());
        Assert.AreEqual("Project00.csproj", projects[0].Name);
        Assert.AreEqual("Project39.csproj", projects[^1].Name);
        Assert.IsTrue(projects.All(project => project.Packages.Count == 1));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_EvaluatedProjects_NeverExceedConfiguredParallelism()
    {
        // Arrange — property-based versions force one evaluator call per project, and the fake
        // holds its slot long enough for the overlap to be observable.
        var projectPaths = new List<string>();
        for (var index = 0; index < 24; index++)
        {
            projectPaths.Add(WriteProject($"Concurrent{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <FooBarVersion>1.2.3</FooBarVersion>
                  </PropertyGroup>
                  <ItemGroup>
                    <PackageReference Include="Foo.Bar" Version="$(FooBarVersion)" />
                  </ItemGroup>
                </Project>
                """));
        }

        var evaluator = new CountingCpmEvaluator(TimeSpan.FromMilliseconds(20));
        using var service = new WorkspaceModelService(cpmEvaluator: evaluator, parseConcurrency: 3);

        // Act
        var projects = await service.GetProjectsAsync(projectPaths, [], CancellationToken.None);

        // Assert
        Assert.AreEqual(24, projects.Count);
        Assert.AreEqual(24, evaluator.Calls);
        Assert.IsTrue(
            evaluator.PeakConcurrency <= 3,
            $"observed {evaluator.PeakConcurrency} concurrent evaluations with parseConcurrency 3.");
        Assert.AreEqual(0, evaluator.ActiveConcurrency);
        Assert.AreEqual("1.2.3", projects[0].Packages[0].Version);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_CancelledDuringBatch_ThrowsOperationCanceled()
    {
        // Arrange — a batch that would need ~400 ms, cancelled after 50 ms.
        var projectPaths = new List<string>();
        for (var index = 0; index < 40; index++)
        {
            projectPaths.Add(WriteProject($"Cancel{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <PropertyGroup>
                    <FooBarVersion>1.2.3</FooBarVersion>
                  </PropertyGroup>
                  <ItemGroup>
                    <PackageReference Include="Foo.Bar" Version="$(FooBarVersion)" />
                  </ItemGroup>
                </Project>
                """));
        }

        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        var evaluator = new CountingCpmEvaluator(TimeSpan.FromMilliseconds(20));
        using var service = new WorkspaceModelService(cpmEvaluator: evaluator, parseConcurrency: 2);

        // Act
        var cancelled = false;
        try
        {
            await service.GetProjectsAsync(projectPaths, [], cancellation.Token);
        }
        catch (OperationCanceledException)
        {
            cancelled = true;
        }

        // Assert — cancellation propagates instead of returning a partial list.
        Assert.IsTrue(cancelled, "GetProjectsAsync should surface the cancellation.");
        Assert.IsTrue(evaluator.Calls > 0, "the batch should have started before it was cancelled.");
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_OneBrokenProjectAmongMany_SkipsOnlyThatProject()
    {
        // Arrange
        var projectPaths = new List<string>();
        for (var index = 0; index < 10; index++)
        {
            projectPaths.Add(WriteProject($"Healthy{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <ItemGroup>
                    <PackageReference Include="Serilog" Version="3.1.1" />
                  </ItemGroup>
                </Project>
                """));
        }

        var broken = workspace!.Combine("Broken.csproj");
        File.WriteAllText(broken, "<Project><unclosed>");
        projectPaths.Insert(4, broken);

        using var service = new WorkspaceModelService(parseConcurrency: 4);

        // Act
        var projects = await service.GetProjectsAsync(projectPaths, [], CancellationToken.None);

        // Assert — only the broken project is dropped.
        Assert.AreEqual(10, projects.Count);
        Assert.IsFalse(projects.Any(project => project.Name.Equals("Broken.csproj", StringComparison.OrdinalIgnoreCase)));
        Assert.AreEqual("Healthy00.csproj", projects[0].Name);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Constructor_NonPositiveParseConcurrency_Throws()
    {
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => new WorkspaceModelService(parseConcurrency: 0));
        Assert.ThrowsExactly<ArgumentOutOfRangeException>(() => new WorkspaceModelService(parseConcurrency: -2));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_WithProgress_ReportsEveryProjectExactlyOnce()
    {
        // Arrange — 20 generated projects and a synchronous collector, so the assertions do not
        // race a SynchronizationContext hop.
        var projectPaths = new List<string>();
        for (var index = 0; index < 20; index++)
        {
            projectPaths.Add(WriteProject($"Progress{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <ItemGroup>
                    <PackageReference Include="Serilog" Version="3.1.1" />
                  </ItemGroup>
                </Project>
                """));
        }

        var progress = new CollectingProgress();

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync(projectPaths, [], CancellationToken.None, progress);

        // Assert — the same projects come back, and the reports cover 1..20 exactly once.
        Assert.AreEqual(20, projects.Count);
        var reports = progress.Reports;
        Assert.AreEqual(20, reports.Count);
        CollectionAssert.AreEquivalent(
            Enumerable.Range(1, 20).ToList(),
            reports.Select(report => report.Completed).Order().ToList());
        Assert.IsTrue(reports.All(report => report.Total == 20), "Total must stay 20 throughout.");
        CollectionAssert.AreEquivalent(
            projectPaths.ToList(),
            reports.Select(report => report.ProjectPath).ToList());
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_ProgressIncludesSkippedProjects()
    {
        // Arrange — a broken project still counts as finished, so the host's counter never stalls.
        var healthy = WriteProject("Healthy", """
            <Project Sdk="Microsoft.NET.Sdk">
              <ItemGroup>
                <PackageReference Include="Serilog" Version="3.1.1" />
              </ItemGroup>
            </Project>
            """);
        var broken = workspace!.Combine("Broken.csproj");
        File.WriteAllText(broken, "<Project><unclosed>");

        var progress = new CollectingProgress();

        using var service = new WorkspaceModelService();

        // Act
        var projects = await service.GetProjectsAsync([healthy, broken], [], CancellationToken.None, progress);

        // Assert
        Assert.AreEqual(1, projects.Count);
        Assert.AreEqual(2, progress.Reports.Count);
        CollectionAssert.AreEquivalent(
            Enumerable.Range(1, 2).ToList(),
            progress.Reports.Select(report => report.Completed).Order().ToList());
        Assert.IsTrue(progress.Reports.All(report => report.Total == 2));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public async Task GetProjectsAsync_WithoutProgress_StillWorks()
    {
        // Arrange
        var projectPaths = new List<string>();
        for (var index = 0; index < 5; index++)
        {
            projectPaths.Add(WriteProject($"NoProgress{index:D2}", """
                <Project Sdk="Microsoft.NET.Sdk">
                  <ItemGroup>
                    <PackageReference Include="Serilog" Version="3.1.1" />
                  </ItemGroup>
                </Project>
                """));
        }

        using var service = new WorkspaceModelService();

        // Act — null progress is the pre-existing call shape and must stay a no-op.
        var projects = await service.GetProjectsAsync(projectPaths, [], CancellationToken.None, progress: null);

        // Assert
        Assert.AreEqual(5, projects.Count);
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

    /// <summary>
    /// An evaluator that stands in for `dotnet msbuild`: it holds its slot for
    /// <paramref name="delay"/> so the parallel window is observable, and records the peak overlap.
    /// It reports the resolved reference through <c>PackageReferences</c>, because the projects it
    /// serves are non-CPM (no `Directory.Packages.props`), so the non-CPM parse path is the one that
    /// consumes the evaluation result.
    /// </summary>
    private sealed class CountingCpmEvaluator(TimeSpan delay) : ICpmEvaluator
    {
        private int active;
        private int peak;
        private int calls;

        public int Calls => Volatile.Read(ref calls);

        public int ActiveConcurrency => Volatile.Read(ref active);

        public int PeakConcurrency => Volatile.Read(ref peak);

        public async Task<CpmEvaluation?> EvaluateAsync(
            string projectPath,
            string? targetFramework,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref calls);
            var activeNow = Interlocked.Increment(ref active);
            RecordPeak(activeNow);

            try
            {
                await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                Interlocked.Decrement(ref active);
            }

            return EvaluationWithReferences(("Foo.Bar", "1.2.3"));
        }

        private void RecordPeak(int activeNow)
        {
            var observed = Volatile.Read(ref peak);
            while (activeNow > observed)
            {
                var prior = Interlocked.CompareExchange(ref peak, activeNow, observed);
                if (prior == observed)
                {
                    return;
                }

                observed = prior;
            }
        }
    }

    /// <summary>
    /// A deterministic <see cref="IProgress{T}" />: reports are recorded synchronously on the
    /// calling thread instead of being posted to a synchronization context.
    /// </summary>
    private sealed class CollectingProgress : IProgress<ProjectParseProgress>
    {
        private readonly List<ProjectParseProgress> reports = [];
        private readonly object gate = new();

        public IReadOnlyList<ProjectParseProgress> Reports
        {
            get
            {
                lock (gate)
                {
                    return [.. reports];
                }
            }
        }

        public void Report(ProjectParseProgress value)
        {
            lock (gate)
            {
                reports.Add(value);
            }
        }
    }

    private string WriteProject(string name, string content) =>
        workspace!.WriteFile($"{name}.csproj", content);
}
