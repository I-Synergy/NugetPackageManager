// File: tests/NugetPackageManager.Core.Workspace.Tests/Dependencies/AssetsGraphTests.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Mirrors `dependency-graph.test.ts`; the assets document is the official restore output.

using NugetPackageManager.Core.Workspace.Dependencies;

namespace NugetPackageManager.Core.Workspace.Tests.Dependencies;

[TestClass]
public class AssetsGraphTests
{
    private static readonly string[] expectedDirectIds = ["pkg.one", "pkg.two"];

    private static string AssetsFor(string directLibVersion, string libRange = ">= 1.0.0") => $$"""
        {
          "targets": {
            "net10.0": {
              "Parent/1.0.0": { "type": "package", "dependencies": { "Lib": "{{libRange}}" } },
              "Lib/{{directLibVersion}}": { "type": "package" }
            }
          },
          "project": {
            "frameworks": {
              "net10.0": {
                "dependencies": {
                  "Parent": { "target": "Package", "version": "[1.0.0, )" },
                  "Lib": { "target": "Package", "version": "[{{directLibVersion}}, )" }
                }
              }
            }
          }
        }
        """;

    [TestMethod]
    [TestCategory("Unit")]
    public void SplitPackageKey_SeparatesIdAndVersion()
    {
        // Act
        var parts = AssetsGraph.SplitPackageKey("Microsoft.Extensions.Logging/10.0.3");

        // Assert
        Assert.IsNotNull(parts);
        Assert.AreEqual("Microsoft.Extensions.Logging", parts.Value.Id);
        Assert.AreEqual("10.0.3", parts.Value.Version);
        Assert.IsNull(AssetsGraph.SplitPackageKey("no-version-here"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Analyze_DirectReferenceTheGraphProvides_IsRedundant()
    {
        // Act
        var issues = AssetsGraph.Analyze(AssetsFor("1.0.0"), "D:/ws/App.csproj");

        // Assert
        Assert.AreEqual(1, issues.Count);
        Assert.AreEqual("Lib", issues[0].PackageId);
        Assert.AreEqual("Redundant", issues[0].Kind);
        Assert.AreEqual("Parent -> Lib", issues[0].Chain);
        Assert.AreEqual("net10.0", issues[0].Tfm);
        Assert.AreEqual("D:/ws/App.csproj", issues[0].ProjectPath);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Analyze_DirectReferenceThatRaisesTheVersion_IsPinned()
    {
        // Act
        var issues = AssetsGraph.Analyze(AssetsFor("2.0.0"), "D:/ws/App.csproj");

        // Assert
        Assert.AreEqual(1, issues.Count);
        Assert.AreEqual("Lib", issues[0].PackageId);
        Assert.AreEqual("Pinned", issues[0].Kind);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Analyze_ChainWithoutALowerBound_IsPinned()
    {
        // Act
        var issues = AssetsGraph.Analyze(AssetsFor("1.5.0", "(, 2.0.0]"), "D:/ws/App.csproj");

        // Assert
        Assert.AreEqual(1, issues.Count);
        Assert.AreEqual("Pinned", issues[0].Kind);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Analyze_TransitivePackagesAreNotReported()
    {
        // Arrange
        const string assets = """
            {
              "targets": {
                "net10.0": {
                  "Parent/1.0.0": { "type": "package", "dependencies": { "Shared": ">= 1.0.0" } },
                  "Other/1.0.0": { "type": "package", "dependencies": { "Shared": ">= 1.0.0" } },
                  "Shared/1.0.0": { "type": "package" }
                }
              },
              "project": {
                "frameworks": {
                  "net10.0": {
                    "dependencies": {
                      "Parent": { "target": "Package" },
                      "Other": { "target": "Package" }
                    }
                  }
                }
              }
            }
            """;

        // Act
        var issues = AssetsGraph.Analyze(assets, "D:/ws/App.csproj");

        // Assert
        Assert.AreEqual(0, issues.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void Analyze_ProjectReferencesAreNotPackages()
    {
        // Arrange
        const string assets = """
            {
              "targets": {
                "net10.0": {
                  "Lib/1.0.0": { "type": "package" },
                  "Sibling/1.0.0": { "type": "project", "dependencies": { "Lib": ">= 1.0.0" } }
                }
              },
              "project": {
                "frameworks": {
                  "net10.0": {
                    "dependencies": {
                      "Sibling": { "target": "Project" },
                      "Lib": { "target": "Package" }
                    }
                  }
                }
              }
            }
            """;

        // Act
        var issues = AssetsGraph.Analyze(assets, "D:/ws/App.csproj");

        // Assert
        Assert.AreEqual(0, issues.Count);
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void ReadDirectDependencies_LowerCasesAndFiltersNonPackages()
    {
        // Arrange
        const string assets = """
            {
              "project": {
                "frameworks": {
                  "net10.0": {
                    "dependencies": {
                      "Pkg.One": { "target": "Package" },
                      "Sibling": { "target": "Project" },
                      "Pkg.Two": {}
                    }
                  }
                }
              }
            }
            """;

        // Act
        var result = AssetsGraph.ReadDirectDependencies(AssetsGraph.Parse(assets));

        // Assert
        Assert.IsTrue(result.HasDirectSection);
        CollectionAssert.AreEquivalent(
            expectedDirectIds,
            result.DirectByTfm["net10.0"].ToArray());
        Assert.AreEqual(0, result.DirectByTfm["net10.0"].Count(entry => entry == "sibling"));
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void AnalyzeProject_MissingAssets_IsSkipped()
    {
        // Arrange
        var directory = Directory.CreateTempSubdirectory("assets-graph-");
        try
        {
            var projectPath = Path.Combine(directory.FullName, "App.csproj");
            File.WriteAllText(projectPath, "<Project />");

            // Act
            var analysis = AssetsGraph.AnalyzeProject(projectPath);

            // Assert
            Assert.IsTrue(analysis.Skipped);
            Assert.AreEqual("project has not been restored", analysis.Reason);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void AnalyzeProject_AssetsOlderThanTheProject_IsSkipped()
    {
        // Arrange
        var directory = Directory.CreateTempSubdirectory("assets-graph-");
        try
        {
            var obj = Directory.CreateDirectory(Path.Combine(directory.FullName, "obj"));
            var projectPath = Path.Combine(directory.FullName, "App.csproj");
            var assetsPath = Path.Combine(obj.FullName, "project.assets.json");
            File.WriteAllText(assetsPath, AssetsFor("1.0.0"));
            File.WriteAllText(projectPath, "<Project />");
            File.SetLastWriteTimeUtc(assetsPath, DateTime.UtcNow.AddMinutes(-5));

            // Act
            var analysis = AssetsGraph.AnalyzeProject(projectPath);

            // Assert
            Assert.IsTrue(analysis.Skipped);
            Assert.AreEqual("assets are older than the project; restore first", analysis.Reason);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }

    [TestMethod]
    [TestCategory("Unit")]
    public void AnalyzeProject_FreshAssets_ReportsIssues()
    {
        // Arrange
        var directory = Directory.CreateTempSubdirectory("assets-graph-");
        try
        {
            var obj = Directory.CreateDirectory(Path.Combine(directory.FullName, "obj"));
            var projectPath = Path.Combine(directory.FullName, "App.csproj");
            var assetsPath = Path.Combine(obj.FullName, "project.assets.json");
            File.WriteAllText(projectPath, "<Project />");
            File.WriteAllText(assetsPath, AssetsFor("1.0.0"));
            File.SetLastWriteTimeUtc(assetsPath, DateTime.UtcNow.AddMinutes(5));

            // Act
            var analysis = AssetsGraph.AnalyzeProject(projectPath);

            // Assert
            Assert.IsFalse(analysis.Skipped);
            Assert.AreEqual(1, analysis.Issues.Count);
            Assert.AreEqual("Lib", analysis.Issues[0].PackageId);
        }
        finally
        {
            directory.Delete(recursive: true);
        }
    }
}
