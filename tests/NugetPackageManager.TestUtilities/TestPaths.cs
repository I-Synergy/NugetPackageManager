// File: tests/NugetPackageManager.TestUtilities/TestPaths.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// Locates the repository once for every C# suite. Before this class each of the four
// fixture-reading test classes carried its own copy of `FindRepositoryRoot`.

namespace NugetPackageManager.TestUtilities;

/// <summary>Locates the repository and the shared test data it owns.</summary>
public static class TestPaths
{
    private const string RepositoryMarker = "package.json";
    private const string FixturesProject = "NugetPackageManager.TestUtilities";

    /// <summary>The repository root, found by walking up from the test assembly to its package.json.</summary>
    public static string RepositoryRoot { get; } = LocateRepositoryRoot();

    /// <summary>The shared fixture tree owned by this project.</summary>
    public static string FixturesRoot { get; } = Path.Combine(RepositoryRoot, "tests", FixturesProject, "Fixtures");

    /// <summary>An absolute path inside the fixture tree, for example <c>Fixture("cpm", "single-group.props")</c>.</summary>
    public static string Fixture(params string[] segments) => Path.Combine([FixturesRoot, .. segments]);

    /// <summary>Reads a fixture as text, for the props and csproj files the tests evaluate.</summary>
    public static string ReadFixture(params string[] segments) => File.ReadAllText(Fixture(segments));

    /// <summary>An absolute path inside the repository, for example <c>Repository("tests", "…")</c>.</summary>
    public static string Repository(params string[] segments) => Path.Combine([RepositoryRoot, .. segments]);

    private static string LocateRepositoryRoot()
    {
        var directory = AppContext.BaseDirectory;

        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory, RepositoryMarker)))
            {
                return directory;
            }

            directory = Path.GetDirectoryName(directory);
        }

        throw new InvalidOperationException($"repository root not found above {AppContext.BaseDirectory}");
    }
}
