using System.Text.RegularExpressions;
using NuGet.Versioning;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>
/// NuGet version semantics for the ported dependency operations.
///
/// The host keeps its TypeScript comparator for its own orchestration (sorting search results,
/// SDK checks); the algorithms that live in the core use <see cref="NuGetVersion"/> and
/// <see cref="VersionRange"/> so there is no second hand-written comparator here.
/// </summary>
internal static partial class VersionSemantics
{
    /// <summary>
    /// NuGet SemVer ordering. A value that does not parse as a version is compared
    /// ordinally; assets files and feeds carry valid versions, so this is only a guard.
    /// </summary>
    public static int Compare(string left, string right)
    {
        if (NuGetVersion.TryParse(left, out var parsedLeft) && NuGetVersion.TryParse(right, out var parsedRight))
        {
            return parsedLeft.CompareTo(parsedRight);
        }

        return string.CompareOrdinal(left, right);
    }

    public static bool AreEqual(string left, string right) => Compare(left, right) == 0;

    /// <summary>
    /// The version a range can resolve to at its lowest end, in the spelling the range used.
    /// Returns null for a range with no lower bound (e.g. <c>(, 2.0.0]</c>).
    /// </summary>
    public static string? RangeLowerBound(string range)
    {
        var trimmed = range.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }

        // NuGet's parser wants interval notation; nuspec's `>= 1.2.3` shorthand is accepted by
        // the TypeScript implementation too, so normalise it before parsing.
        var normalised = ComparisonPrefix().Replace(trimmed, string.Empty);

        if (!VersionRange.TryParse(normalised, out var parsed)
            || parsed.Float is not null
            || parsed.MinVersion is null)
        {
            // A floating range (`1.*`) has no single version to require.
            return null;
        }

        return parsed.MinVersion.OriginalVersion ?? parsed.MinVersion.ToNormalizedString();
    }

    /// <summary>
    /// Whether a concrete version satisfies a dependency range.
    ///
    /// An empty or unparseable range counts as unconstrained, matching the TypeScript contract:
    /// a suggestion is never hidden because the metadata could not be understood.
    /// </summary>
    public static bool Satisfies(string version, string range)
    {
        var trimmed = range.Trim();
        if (trimmed.Length == 0)
        {
            return true;
        }

        if (!VersionRange.TryParse(trimmed, out var parsed) || !NuGetVersion.TryParse(version, out var candidate))
        {
            return true;
        }

        return parsed.Float is not null
            ? parsed.Float.Satisfies(candidate)
            : parsed.Satisfies(candidate);
    }

    [GeneratedRegex("^>=?\\s*", RegexOptions.CultureInvariant)]
    private static partial Regex ComparisonPrefix();
}