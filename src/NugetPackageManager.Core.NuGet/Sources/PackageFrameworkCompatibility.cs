using NuGet.Frameworks;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// Decides whether a package version's declared target frameworks can be consumed by a
/// project's target frameworks.
///
/// The answer is always fail open: when the feed publishes no framework data, or a project
/// framework cannot be parsed, the result is <c>Known:false, Compatible:true</c> so an
/// unprovable candidate is never hidden from the user. Only a version whose declared
/// frameworks are known and none of which is compatible is reported incompatible.
/// </summary>
public static class PackageFrameworkCompatibility
{
    /// <summary>
    /// Parses the project's target framework names (short folder names such as <c>net10.0</c> or
    /// <c>net10.0-android36.0</c>).
    ///
    /// Returns <c>null</c> when any non-empty name fails to parse, or when no name parses, which
    /// the caller treats as "unknown" and therefore compatible. Blank names are skipped.
    /// </summary>
    public static IReadOnlyList<NuGetFramework>? ParseProjectFrameworks(
        IEnumerable<string> projectFrameworks)
    {
        ArgumentNullException.ThrowIfNull(projectFrameworks);

        var parsed = new List<NuGetFramework>();

        foreach (var name in projectFrameworks)
        {
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            NuGetFramework framework;
            try
            {
                framework = NuGetFramework.ParseFolder(name);
            }
            catch (Exception exception) when (exception is ArgumentException or FormatException)
            {
                return null;
            }

            if (!framework.IsSpecificFramework)
            {
                return null;
            }

            parsed.Add(framework);
        }

        if (parsed.Count == 0)
        {
            return null;
        }

        return parsed;
    }

    /// <summary>
    /// Evaluates one package version against the project frameworks.
    ///
    /// <para>
    /// <c>Known:false, Compatible:true</c> when there is nothing to prove compatibility from: no
    /// project frameworks (unparseable input), or the version declares no frameworks. A declared
    /// any/unspecified framework means the package supports every project, so
    /// <c>Known:true, Compatible:true</c>. Otherwise the version is compatible only when every
    /// project framework is served by at least one declared framework.
    /// </para>
    /// </summary>
    public static PackageVersionCompatibility Evaluate(
        string version,
        IEnumerable<NuGetFramework> declaredFrameworks,
        IReadOnlyList<NuGetFramework>? projectFrameworks)
    {
        ArgumentNullException.ThrowIfNull(version);
        ArgumentNullException.ThrowIfNull(declaredFrameworks);

        var declared = declaredFrameworks
            .Where(framework => framework is not null && !framework.IsUnsupported)
            .Distinct(NuGetFrameworkFullComparer.Instance)
            .ToList();

        if (projectFrameworks is null
            || projectFrameworks.Count == 0
            || declared.Count == 0)
        {
            return new PackageVersionCompatibility
            {
                Version = version,
                Compatible = true,
                Known = false,
            };
        }

        if (declared.Any(framework => framework.IsAny || framework.IsAgnostic))
        {
            return new PackageVersionCompatibility
            {
                Version = version,
                Compatible = true,
                Known = true,
            };
        }

        var compatible = projectFrameworks.All(projectFramework =>
            declared.Any(declaredFramework =>
                DefaultCompatibilityProvider.Instance.IsCompatible(projectFramework, declaredFramework)));

        return new PackageVersionCompatibility
        {
            Version = version,
            Compatible = compatible,
            Known = true,
        };
    }
}
