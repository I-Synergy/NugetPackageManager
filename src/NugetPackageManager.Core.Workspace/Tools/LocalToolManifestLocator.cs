namespace NugetPackageManager.Core.Workspace.Tools;

/// <summary>
/// Finds every <c>.config/dotnet-tools.json</c> a workspace declares.
///
/// A repository can pin local tools in more than one manifest: the SDK picks the nearest
/// manifest at or above the working directory, so a solution folder and a nested tool folder
/// routinely carry their own file. Discovery therefore walks each workspace root (never leaving
/// it) and additionally walks up from every supplied project directory. Build output, package and
/// hidden folders are skipped, and the result is deduplicated by real path so a symlinked or
/// repeated root does not list the same manifest twice.
///
/// A hidden directory segment (`.`-prefixed) marks a folder as internal, exactly as project
/// discovery already does: scratch and cache trees such as <c>.ai/tmp</c>, VCS metadata and editor
/// state never declare tools the user owns. The manifest folder itself is <c>.config</c>, but it is
/// tested for directly and never traversed, so a legitimate manifest is still found.
/// </summary>
public static class LocalToolManifestLocator
{
    /// <summary>The file name inside a <c>.config</c> folder.</summary>
    public const string ManifestFileName = "dotnet-tools.json";

    /// <summary>The folder that holds the manifest.</summary>
    public const string ConfigDirectoryName = ".config";

    /// <summary>Folders that never hold a manifest worth reporting.</summary>
    private static readonly string[] ignoredDirectories =
        ["bin", "obj", "node_modules", ".git", ".vs"];

    private static readonly StringComparer pathComparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>
    /// Every manifest the workspace declares, ordered by path. Roots that do not exist and
    /// projects outside every root are ignored rather than reported.
    /// </summary>
    /// <param name="workspaceRoots">The folders the workspace owns; a manifest outside them is never reported.</param>
    /// <param name="projectPaths">Projects whose manifest is looked up by walking up to the root.</param>
    /// <param name="cancellationToken">Cancels the walk.</param>
    public static IReadOnlyList<string> FindManifests(
        IReadOnlyList<string>? workspaceRoots,
        IReadOnlyList<string>? projectPaths = null,
        CancellationToken cancellationToken = default)
    {
        if (workspaceRoots is null || workspaceRoots.Count == 0)
        {
            return [];
        }

        var roots = ReadRoots(workspaceRoots, cancellationToken);
        if (roots.Count == 0)
        {
            return [];
        }

        var found = new Dictionary<string, string>(pathComparer);
        foreach (var root in roots)
        {
            CollectManifests(root, found, cancellationToken);
        }

        foreach (var projectPath in projectPaths ?? [])
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrWhiteSpace(projectPath))
            {
                continue;
            }

            CollectFromProjectsUpwards(projectPath, roots, found);
        }

        return [.. found.Values.OrderBy(path => path, pathComparer)];
    }

    private static List<string> ReadRoots(
        IReadOnlyList<string> workspaceRoots,
        CancellationToken cancellationToken)
    {
        var roots = new List<string>();

        foreach (var root in workspaceRoots)
        {
            cancellationToken.ThrowIfCancellationRequested();

            if (string.IsNullOrWhiteSpace(root))
            {
                continue;
            }

            string full;
            try
            {
                full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
            }
            catch (ArgumentException)
            {
                // An unusable path is not a workspace root; there is nothing to report for it.
                continue;
            }

            if (Directory.Exists(full) && !roots.Contains(full, pathComparer))
            {
                roots.Add(full);
            }
        }

        return roots;
    }

    /// <summary>Walks one root breadth-first, skipping build output, package and hidden folders.</summary>
    private static void CollectManifests(
        string root,
        Dictionary<string, string> found,
        CancellationToken cancellationToken)
    {
        var pending = new Stack<string>();
        var visited = new HashSet<string>(pathComparer);
        pending.Push(root);

        while (pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var directory = pending.Pop();
            if (!visited.Add(directory))
            {
                continue;
            }

            AddCandidate(Path.Combine(directory, ConfigDirectoryName, ManifestFileName), found);

            List<string> children;
            try
            {
                children = [.. Directory.EnumerateDirectories(directory)];
            }
            catch (IOException)
            {
                continue;
            }
            catch (UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var child in children)
            {
                // The candidate check above already covered `<directory>/.config`; a hidden child is
                // internal (`.ai` scratch trees, `.git`, `.vs`), so its subtree is never walked.
                var name = Path.GetFileName(child);
                if (IsIgnoredDirectory(name) || IsHiddenDirectory(name) || IsLinkedDirectory(child))
                {
                    continue;
                }

                pending.Push(child);
            }
        }
    }

    /// <summary>Walks up from a project to the root that owns it, never leaving that root.</summary>
    private static void CollectFromProjectsUpwards(
        string projectPath,
        IReadOnlyList<string> roots,
        Dictionary<string, string> found)
    {
        string directory;
        try
        {
            directory = Path.GetDirectoryName(Path.GetFullPath(projectPath)) ?? string.Empty;
        }
        catch (ArgumentException)
        {
            return;
        }

        while (directory.Length > 0)
        {
            var owner = FindOwningRoot(directory, roots);

            // A manifest above the workspace root is not ours: stop as soon as the walk leaves.
            if (owner is null)
            {
                return;
            }

            // A project under a hidden folder (`<root>/.ai/tmp/x/app.csproj`) is internal, but the
            // walk continues upwards so a legitimate manifest on the visible part of the path is
            // still reported.
            if (!IsInHiddenDirectory(directory, owner))
            {
                AddCandidate(Path.Combine(directory, ConfigDirectoryName, ManifestFileName), found);
            }

            var parent = Path.GetDirectoryName(directory);
            if (string.IsNullOrEmpty(parent) || pathComparer.Equals(parent, directory))
            {
                return;
            }

            directory = parent;
        }
    }

    private static bool IsIgnoredDirectory(string name) =>
        ignoredDirectories.Contains(name, pathComparer);

    /// <summary>A hidden folder is internal; the same rule project discovery applies.</summary>
    private static bool IsHiddenDirectory(string name) => name.StartsWith('.');

    /// <summary>The deepest workspace root that owns <paramref name="directory"/>, or <c>null</c>.</summary>
    private static string? FindOwningRoot(string directory, IReadOnlyList<string> roots)
    {
        string? owner = null;

        foreach (var root in roots)
        {
            if (IsSameOrInside(directory, root) && (owner is null || root.Length > owner.Length))
            {
                owner = root;
            }
        }

        return owner;
    }

    /// <summary>
    /// Whether any segment between <paramref name="root"/> and <paramref name="directory"/> is
    /// hidden. The owner of <c>.config</c> decides: a hidden ancestor marks the manifest as
    /// internal even when the manifest file itself is on a visible-looking name.
    /// </summary>
    private static bool IsInHiddenDirectory(string directory, string root)
    {
        var relative = Path.GetRelativePath(root, directory);
        if (relative is "" or ".")
        {
            return false;
        }

        return relative
            .Split([Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar], StringSplitOptions.RemoveEmptyEntries)
            .Any(IsHiddenDirectory);
    }

    /// <summary>
    /// A directory symlink is not followed: it can leave the workspace and it can form a loop.
    /// </summary>
    private static bool IsLinkedDirectory(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
        }
        catch (IOException)
        {
            return true;
        }
        catch (UnauthorizedAccessException)
        {
            return true;
        }
    }

    private static void AddCandidate(string manifestPath, Dictionary<string, string> found)
    {
        string real;
        try
        {
            if (!File.Exists(manifestPath))
            {
                return;
            }

            real = RealPath(manifestPath);
        }
        catch (IOException)
        {
            return;
        }
        catch (UnauthorizedAccessException)
        {
            return;
        }

        found.TryAdd(real, Path.GetFullPath(manifestPath));
    }

    private static string RealPath(string path)
    {
        var full = Path.GetFullPath(path);

        try
        {
            return new FileInfo(full).ResolveLinkTarget(returnFinalTarget: true) is { } target
                ? Path.GetFullPath(target.FullName)
                : full;
        }
        catch (IOException)
        {
            return full;
        }
        catch (UnauthorizedAccessException)
        {
            return full;
        }
    }

    private static bool IsSameOrInside(string path, string root) =>
        pathComparer.Equals(path, root)
        || path.StartsWith(Prefix(root), PathComparison);

    /// <summary>The root with a trailing separator, so "C:\ws2" is not treated as inside "C:\ws".</summary>
    private static string Prefix(string root) =>
        Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar;

    private static StringComparison PathComparison =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
}
