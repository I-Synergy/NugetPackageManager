// File: tests/NugetPackageManager.TestUtilities/TemporaryDirectory.cs
// Traces: none — legacy mode, this slice declares no acceptance criteria.
//
// A disposable temp workspace. Before this class the suites repeated
// `Path.Combine(Path.GetTempPath(), tag, Guid.NewGuid()...)` + create + delete inline.

namespace NugetPackageManager.TestUtilities;

/// <summary>A throw-away directory that deletes itself when disposed.</summary>
public sealed class TemporaryDirectory : IDisposable
{
    /// <summary>Creates a uniquely named directory under the system temp path.</summary>
    /// <param name="tag">A short label that keeps parallel suites readable in the temp path.</param>
    public TemporaryDirectory(string tag = "nuget-tests")
    {
        Root = Path.Combine(Path.GetTempPath(), tag, Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Root);
    }

    /// <summary>The absolute path of this directory.</summary>
    public string Root { get; }

    /// <summary>An absolute path inside this directory; the segments are not created.</summary>
    public string Combine(params string[] segments) => System.IO.Path.Combine([Root, .. segments]);

    /// <summary>Creates the directory (including parents) and returns the absolute path.</summary>
    public string CreateDirectory(params string[] segments)
    {
        var directory = Combine(segments);
        Directory.CreateDirectory(directory);
        return directory;
    }

    /// <summary>Writes a UTF-8 text file, creating parent directories, and returns its path.</summary>
    public string WriteFile(string name, string content)
    {
        var file = Combine(name);
        var parent = System.IO.Path.GetDirectoryName(file);

        if (!string.IsNullOrEmpty(parent))
        {
            Directory.CreateDirectory(parent);
        }

        File.WriteAllText(file, content);
        return file;
    }

    /// <inheritdoc />
    public void Dispose()
    {
        if (Directory.Exists(Root))
        {
            Directory.Delete(Root, recursive: true);
        }

        GC.SuppressFinalize(this);
    }
}
