// File: tests/NugetPackageManager.Core.Workspace.Tests/Cpm/CpmPropertyResolverTests.cs
// Traces: .ai/plans/aspire-parse-cost.md, Phase A + A2 — a props chain whose versions are literals
// behind `$(Property)` must resolve without a `dotnet msbuild` evaluation, and an entry the chain
// cannot prove must be left exactly as written while every other entry still resolves.

using System.Diagnostics.CodeAnalysis;
using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.TestUtilities;

namespace NugetPackageManager.Core.Workspace.Tests.Cpm;

[TestClass]
[SuppressMessage(
    "Design",
    "CA1001:Types that own disposable fields should be disposable",
    Justification = "MSTest creates one instance per test and TestCleanup disposes the temp directory.")]
public class CpmPropertyResolverTests
{
    private TemporaryDirectory? workspace;

    [TestInitialize]
    public void Setup()
    {
        workspace = new TemporaryDirectory("cpm-property-resolver");
    }

    [TestCleanup]
    public void Cleanup()
    {
        workspace?.Dispose();
        workspace = null;
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_LiteralDefinedInSameFile_SubstitutesVersion()
    {
        // Arrange
        var props = WriteProps("""
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
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("1.2.3", resolved.Unconditional["Foo.Bar"]);
        Assert.IsFalse(resolved.HasConditionalGroups);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropertyDefinedInImportedFile_SubstitutesVersion()
    {
        // Arrange — the Aspire shape: the props file imports `eng/Versions.props`.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>4.5.6</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="eng\Versions.props" />
              <PropertyGroup>
                <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("4.5.6", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_ImportWithThisFileDirectory_IsFollowed()
    {
        // Arrange — `$(MSBuildThisFileDirectory)` needs no evaluation, so the chain is readable.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>4.5.6</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="$(MSBuildThisFileDirectory)eng/Versions.props" />
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("4.5.6", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_ConcatenatedValue_LeavesEntryAsWritten()
    {
        // Arrange — `$(FooBarVersion)-beta` is not a single reference, so it needs MSBuild.
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)-beta" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert — the entry keeps the expression; the caller keeps the MSBuild path for it only.
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$(FooBarVersion)-beta", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_MissingProperty_LeavesEntryAsWritten()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(NowhereVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$(NowhereVersion)", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropsFileMissing_ReturnsNull()
    {
        // Arrange — a props file that cannot be read is the only case that answers null.
        var props = workspace!.Combine("Directory.Packages.props");
        var map = new CpmPackageMap(
            new Dictionary<string, string>(StringComparer.Ordinal) { ["Foo.Bar"] = "$(FooBarVersion)" },
            [],
            false);

        using var resolver = new CpmPropertyResolver();

        // Act + Assert
        Assert.IsNull(resolver.TryResolve(props, map));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_OneUndefinedNameAmongMany_ResolvesTheRest()
    {
        // Arrange — Aspire's shape: ten properties are literals and the eleventh
        // (`MicrosoftSignedWixVersion`) is defined nowhere in the import chain.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <Version1>1.0.0</Version1>
                <Version2>2.0.0</Version2>
                <Version3>3.0.0</Version3>
                <Version4>4.0.0</Version4>
                <Version5>5.0.0</Version5>
                <Version6>6.0.0</Version6>
                <Version7>7.0.0</Version7>
                <Version8>8.0.0</Version8>
                <Version9>9.0.0</Version9>
                <Version10>10.0.0</Version10>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="eng\Versions.props" />
              <ItemGroup>
                <PackageVersion Include="Pkg.One" Version="$(Version1)" />
                <PackageVersion Include="Pkg.Two" Version="$(Version2)" />
                <PackageVersion Include="Pkg.Three" Version="$(Version3)" />
                <PackageVersion Include="Pkg.Four" Version="$(Version4)" />
                <PackageVersion Include="Pkg.Five" Version="$(Version5)" />
                <PackageVersion Include="Pkg.Six" Version="$(Version6)" />
                <PackageVersion Include="Pkg.Seven" Version="$(Version7)" />
                <PackageVersion Include="Pkg.Eight" Version="$(Version8)" />
                <PackageVersion Include="Pkg.Nine" Version="$(Version9)" />
                <PackageVersion Include="Pkg.Ten" Version="$(Version10)" />
                <PackageVersion Include="Microsoft.Signed.Wix" Version="$(MicrosoftSignedWixVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert — ten substituted, the eleventh untouched.
        Assert.IsNotNull(resolved);
        Assert.AreEqual(11, resolved.Unconditional.Count);
        for (var index = 1; index <= 10; index++)
        {
            Assert.AreEqual($"{index}.0.0", resolved.Unconditional[$"Pkg.{NumberWord(index)}"]);
        }

        Assert.AreEqual("$(MicrosoftSignedWixVersion)", resolved.Unconditional["Microsoft.Signed.Wix"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_UnresolvedConditionalEntry_KeepsOnlyThatEntry()
    {
        // Arrange — the unconditional version resolves; the conditional group references a name no
        // props file defines, so it must survive as written and leave the per-TFM path in charge.
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <SharedVersion>1.0.0</SharedVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Shared.Library" Version="$(SharedVersion)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Microsoft.Signed.Wix" Version="$(MicrosoftSignedWixVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("1.0.0", resolved.Unconditional["Shared.Library"]);
        Assert.IsTrue(resolved.HasConditionalGroups);
        Assert.AreEqual(1, resolved.Conditional.Count);
        Assert.AreEqual(map.Conditional[0].Condition, resolved.Conditional[0].Condition);
        Assert.AreEqual(
            "$(MicrosoftSignedWixVersion)",
            resolved.Conditional[0].Versions["Microsoft.Signed.Wix"]);
    }

    private static string NumberWord(int value) => value switch
    {
        1 => "One",
        2 => "Two",
        3 => "Three",
        4 => "Four",
        5 => "Five",
        6 => "Six",
        7 => "Seven",
        8 => "Eight",
        9 => "Nine",
        _ => "Ten",
    };

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropertyDefinedTwiceWithDifferentValues_LeavesEntryAsWritten()
    {
        // Arrange — the imported file disagrees with the props file; picking either is a guess.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>9.9.9</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="eng\Versions.props" />
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert — the ambiguous name is refused, the entry stays an expression.
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$(FooBarVersion)", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropertyDefinedTwiceWithSameValue_SubstitutesVersion()
    {
        // Arrange — one distinct literal, defined twice: still unambiguous.
        workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="eng\Versions.props" />
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("1.2.3", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_MsBuildFunction_LeavesEntryAsWritten()
    {
        // Arrange — `$([System.String]::Copy(...))` is an evaluation, not a lookup.
        var props = WriteProps("""
            <Project>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$([System.String]::Copy('1.2.3'))" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert — the expression survives verbatim for the MSBuild path.
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$([System.String]::Copy('1.2.3'))", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropertyDefinedByFunction_LeavesEntryAsWritten()
    {
        // Arrange — the definition itself is not a literal, so the value is unknowable here.
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <FooBarVersion>$([System.String]::Copy('1.2.3'))</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$(FooBarVersion)", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_UnknownImportPath_LeavesEntriesAsWritten()
    {
        // Arrange — an import path that needs a real evaluation cannot be followed safely, so the
        // whole chain is untrusted and nothing is substituted; the map itself is still returned.
        var props = WriteProps("""
            <Project>
              <Import Project="$(VersionsPropsPath)" />
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(resolved);
        Assert.AreEqual("$(FooBarVersion)", resolved.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_ConditionalEntries_KeepStructureAndGetSubstituted()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <Net10Version>10.0.1</Net10Version>
                <Net11Version>11.0.0</Net11Version>
                <SharedVersion>1.0.0</SharedVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Shared.Library" Version="$(SharedVersion)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net10.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net10Version)" />
              </ItemGroup>
              <ItemGroup Condition="'$(TargetFramework)' == 'net11.0'">
                <PackageVersion Include="Pkg.Shared" Version="$(Net11Version)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert — same shape, same order, same labels, substituted versions.
        Assert.IsNotNull(resolved);
        Assert.IsTrue(resolved.HasConditionalGroups);
        Assert.AreEqual("1.0.0", resolved.Unconditional["Shared.Library"]);
        Assert.AreEqual(map.Conditional.Count, resolved.Conditional.Count);
        for (var index = 0; index < map.Conditional.Count; index++)
        {
            Assert.AreEqual(map.Conditional[index].Condition, resolved.Conditional[index].Condition);
            Assert.AreEqual(map.Conditional[index].Framework, resolved.Conditional[index].Framework);
            Assert.AreEqual(map.Conditional[index].Order, resolved.Conditional[index].Order);
        }

        Assert.AreEqual("10.0.1", resolved.Conditional[0].Versions["Pkg.Shared"]);
        Assert.AreEqual("11.0.0", resolved.Conditional[1].Versions["Pkg.Shared"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_MapWithoutPropertyReferences_IsReturnedUnchanged()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="1.2.3" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.AreSame(map, resolved);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_UnchangedFiles_ReusesCachedTable()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();

        // Act
        var first = resolver.TryResolve(props, map);
        var second = resolver.TryResolve(props, map);

        // Assert — the chain was read once, and both calls answer the same thing.
        Assert.AreEqual(1, resolver.ChainReads);
        Assert.IsNotNull(first);
        Assert.IsNotNull(second);
        Assert.AreEqual("1.2.3", second.Unconditional["Foo.Bar"]);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_PropsFileChanged_InvalidatesCache()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();
        var before = resolver.TryResolve(props, map);
        Assert.IsNotNull(before);
        Assert.AreEqual("1.2.3", before.Unconditional["Foo.Bar"]);

        // Act — rewrite the props file and push its timestamp forward so granularity cannot hide it.
        File.WriteAllText(props, """
            <Project>
              <PropertyGroup>
                <FooBarVersion>2.0.0</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        File.SetLastWriteTimeUtc(props, DateTime.UtcNow.AddMinutes(1));
        var after = resolver.TryResolve(props, Parse(props));

        // Assert
        Assert.IsNotNull(after);
        Assert.AreEqual("2.0.0", after.Unconditional["Foo.Bar"]);
        Assert.AreEqual(2, resolver.ChainReads);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void TryResolve_ImportedFileChanged_InvalidatesCache()
    {
        // Arrange
        var versions = workspace!.WriteFile("eng/Versions.props", """
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        var props = WriteProps("""
            <Project>
              <Import Project="eng\Versions.props" />
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();
        var before = resolver.TryResolve(props, map);
        Assert.IsNotNull(before);
        Assert.AreEqual("1.2.3", before.Unconditional["Foo.Bar"]);

        // Act — the props file is untouched; only the imported file changes.
        File.WriteAllText(versions, """
            <Project>
              <PropertyGroup>
                <FooBarVersion>2.0.0</FooBarVersion>
              </PropertyGroup>
            </Project>
            """);
        File.SetLastWriteTimeUtc(versions, DateTime.UtcNow.AddMinutes(1));
        var after = resolver.TryResolve(props, map);

        // Assert
        Assert.IsNotNull(after);
        Assert.AreEqual("2.0.0", after.Unconditional["Foo.Bar"]);
        Assert.AreEqual(2, resolver.ChainReads);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ClearCache_ForcesTheChainToBeReadAgain()
    {
        // Arrange
        var props = WriteProps("""
            <Project>
              <PropertyGroup>
                <FooBarVersion>1.2.3</FooBarVersion>
              </PropertyGroup>
              <ItemGroup>
                <PackageVersion Include="Foo.Bar" Version="$(FooBarVersion)" />
              </ItemGroup>
            </Project>
            """);
        var map = Parse(props);

        using var resolver = new CpmPropertyResolver();
        _ = resolver.TryResolve(props, map);

        // Act
        resolver.ClearCache();
        var resolved = resolver.TryResolve(props, map);

        // Assert
        Assert.AreEqual(2, resolver.ChainReads);
        Assert.IsNotNull(resolved);
    }

    private static CpmPackageMap Parse(string propsPath) => CpmPropsReader.Parse(File.ReadAllText(propsPath));

    private string WriteProps(string content) => workspace!.WriteFile("Directory.Packages.props", content);
}
