using System.Xml.Linq;
using NugetPackageManager.Core.Workspace.Models;

namespace NugetPackageManager.Core.Workspace.Projects;

/// <summary>
/// Reads a <c>.csproj</c> (or <c>.fsproj</c>/<c>.vbproj</c>) into the project model the
/// webview consumes.
///
/// Elements are matched by local name, which covers both the 2003 MSBuild namespace and
/// SDK-style projects without a namespace — the same fallback the TypeScript parser uses.
/// </summary>
public static class ProjectFileReader
{
    public const string SourceProject = "project";
    public const string SourceCentral = "central";
    public const string SourceOverride = "override";

    /// <summary>
    /// Reads one project. <paramref name="cpmVersions"/> is the flat CPM map the caller has
    /// already resolved (package id → version); passing null leaves every version at its
    /// project value.
    /// </summary>
    public static ProjectModel Read(string projectPath, IReadOnlyDictionary<string, string>? cpmVersions = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        var document = XDocument.Load(projectPath);
        var packages = new List<ProjectPackageModel>();

        foreach (var reference in FindElements(FindElements(document.Root, "ItemGroup"), "PackageReference"))
        {
            var packageId = reference.Attribute("Include")?.Value ?? string.Empty;
            if (packageId.Length == 0)
            {
                continue;
            }

            var version = ReadVersion(reference);
            var versionOverride = ReadVersionOverride(reference);

            var (resolvedVersion, versionSource) = ResolveVersion(packageId, version, versionOverride, cpmVersions);

            packages.Add(new ProjectPackageModel
            {
                Id = packageId,
                Version = resolvedVersion,
                IsPinned = IsPinnedVersion(resolvedVersion),
                VersionSource = versionSource,
            });
        }

        return new ProjectModel
        {
            Path = projectPath,
            Name = System.IO.Path.GetFileName(projectPath),
            Packages = packages,
            CpmEnabled = false,
        };
    }

    /// <summary><c>[1.0]</c> is an exact version; a range with a comma is not pinned.</summary>
    public static bool IsPinnedVersion(string? version) =>
        !string.IsNullOrEmpty(version)
        && version.StartsWith('[')
        && version.EndsWith(']')
        && !version.Contains(',', StringComparison.Ordinal);

    private static (string Version, string VersionSource) ResolveVersion(
        string packageId,
        string? version,
        string? versionOverride,
        IReadOnlyDictionary<string, string>? cpmVersions)
    {
        if (!string.IsNullOrEmpty(versionOverride))
        {
            return (versionOverride, SourceOverride);
        }

        if (cpmVersions is not null
            && cpmVersions.TryGetValue(packageId, out var centralVersion)
            && !string.IsNullOrEmpty(centralVersion))
        {
            return (centralVersion, SourceCentral);
        }

        return (version ?? string.Empty, SourceProject);
    }

    private static string? ReadVersion(XElement reference) =>
        reference.Attribute("Version")?.Value is { Length: > 0 } attribute
            ? attribute
            : ChildValue(reference, "Version");

    private static string? ReadVersionOverride(XElement reference) =>
        reference.Attribute("VersionOverride")?.Value is { Length: > 0 } attribute
            ? attribute
            : ChildValue(reference, "VersionOverride");

    private static string? ChildValue(XElement parent, string localName)
    {
        var child = FindElements([parent], localName).FirstOrDefault();
        if (child is null)
        {
            return null;
        }

        var value = child.Value.Trim();
        return value.Length > 0 ? value : null;
    }

    /// <summary>Descendants by local name, ignoring the MSBuild namespace.</summary>
    private static IEnumerable<XElement> FindElements(XElement? root, string localName) =>
        root is null
            ? []
            : root.Descendants().Where(element => element.Name.LocalName == localName);

    private static IEnumerable<XElement> FindElements(IEnumerable<XElement> roots, string localName) =>
        roots.SelectMany(root => root.Descendants()).Where(element => element.Name.LocalName == localName);
}
