using System.Xml.Linq;
using static NugetPackageManager.Common.Constants;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Reads <c>Directory.Packages.props</c> and resolves package versions per target framework.
///
/// This is the read half of the former TypeScript `CpmResolver`; the write half lives in
/// <c>CpmWriter</c>. The TypeScript twins have been deleted, so this file and <c>CpmWriter</c>
/// are the only CPM implementations.
/// </summary>
public static class CpmPropsReader
{
    private const string PackageVersionElement = "PackageVersion";
    private const string IncludeAttribute = "Include";
    private const string VersionAttribute = "Version";
    private const string ConditionAttribute = "Condition";

    /// <summary>Parses props content into the framework-aware map.</summary>
    public static CpmPackageMap Parse(string content)
    {
        ArgumentNullException.ThrowIfNull(content);

        var unconditional = new Dictionary<string, string>(StringComparer.Ordinal);
        var conditional = new List<CpmFrameworkEntry>();
        var hasConditionalGroups = false;
        var order = 0;

        foreach (var group in ItemGroups(content))
        {
            var packageVersions = PackageVersionsOf(group);
            if (packageVersions.Count == 0)
            {
                continue;
            }

            var groupCondition = (group.Attribute(ConditionAttribute)?.Value ?? string.Empty).Trim();
            foreach (var packageVersion in packageVersions)
            {
                order++;
                if (AddPackageVersion(packageVersion, groupCondition, order, unconditional, conditional))
                {
                    hasConditionalGroups = true;
                }
            }
        }

        return new CpmPackageMap(unconditional, conditional, hasConditionalGroups);
    }

    private static List<XElement> PackageVersionsOf(XElement group) =>
        [.. group.Elements().Where(element => element.Name.LocalName == PackageVersionElement)];

    /// <summary>Records one version line; returns true when it belongs to a conditional group.</summary>
    private static bool AddPackageVersion(
        XElement packageVersion,
        string groupCondition,
        int order,
        Dictionary<string, string> unconditional,
        List<CpmFrameworkEntry> conditional)
    {
        var packageId = packageVersion.Attribute(IncludeAttribute)?.Value;
        var version = packageVersion.Attribute(VersionAttribute)?.Value;
        var elementCondition = (packageVersion.Attribute(ConditionAttribute)?.Value ?? string.Empty).Trim();

        if (string.IsNullOrEmpty(packageId) || string.IsNullOrEmpty(version))
        {
            return false;
        }

        var condition = CombineConditions(groupCondition, elementCondition);
        if (condition.Length == 0)
        {
            unconditional[packageId] = version;
            return false;
        }

        var entry = conditional.Find(candidate => candidate.Condition == condition);
        if (entry is null)
        {
            entry = new CpmFrameworkEntry
            {
                Condition = condition,
                Framework = CpmCondition.GetLabel(condition),
                Versions = [],
                Order = order,
            };
            conditional.Add(entry);
        }
        else
        {
            // The same condition may recur in later groups; document order has to reflect the
            // last occurrence so last-match-wins stays correct.
            entry.Order = order;
        }

        entry.Versions[packageId] = version;
        return true;
    }

    /// <summary>
    /// Flat package → version map, ignoring conditions. Matches the TypeScript
    /// <c>ParsePackageVersionsAsync</c>, whose XPath selects every <c>PackageVersion</c> and lets
    /// the last one win.
    /// </summary>
    public static Dictionary<string, string> ReadFlatVersions(string content)
    {
        ArgumentNullException.ThrowIfNull(content);

        var versions = new Dictionary<string, string>(StringComparer.Ordinal);

        foreach (var packageVersion in ItemGroups(content)
            .SelectMany(group => group.Elements().Where(element => element.Name.LocalName == "PackageVersion")))
        {
            var packageId = packageVersion.Attribute("Include")?.Value;
            var version = packageVersion.Attribute("Version")?.Value;

            if (!string.IsNullOrEmpty(packageId) && !string.IsNullOrEmpty(version))
            {
                versions[packageId] = version;
            }
        }

        return versions;
    }

    /// <summary>
    /// The nearest <c>Directory.Packages.props</c> above the project, or null. The filesystem
    /// root itself is not probed, matching the TypeScript walk.
    /// </summary>
    public static string? FindCpmFile(string projectPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        var directory = Path.GetDirectoryName(projectPath);
        while (!string.IsNullOrEmpty(directory))
        {
            var candidate = Path.Combine(directory, PropsFileName);
            if (File.Exists(candidate))
            {
                return candidate;
            }

            var parent = Path.GetDirectoryName(directory);
            if (string.IsNullOrEmpty(parent) || parent == directory)
            {
                break;
            }

            directory = parent;
        }

        return null;
    }

    /// <summary>
    /// True when the props file enables central package management and the project does not
    /// opt out of it.
    /// </summary>
    public static bool IsEnabled(string projectPath, string cpmFilePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(cpmFilePath);

        var propsEnabled = PropertyValue(File.ReadAllText(cpmFilePath), "ManagePackageVersionsCentrally");
        if (!string.Equals(propsEnabled, "true", StringComparison.Ordinal))
        {
            return false;
        }

        var projectSetting = PropertyValue(File.ReadAllText(projectPath), "ManagePackageVersionsCentrally");
        return !string.Equals(projectSetting, "false", StringComparison.Ordinal);
    }

    /// <summary>Flat CPM versions for a project, or null when CPM does not apply.</summary>
    public static Dictionary<string, string>? GetPackageVersions(string projectPath)
    {
        var cpmFile = FindCpmFile(projectPath);
        if (cpmFile is null || !IsEnabled(projectPath, cpmFile))
        {
            return null;
        }

        return ReadFlatVersions(File.ReadAllText(cpmFile));
    }

    /// <summary>
    /// Resolves every package version for every supplied target framework.
    ///
    /// Conditions are evaluated per TFM and the last matching group in document order wins.
    /// With no resolvable TFM, each conditional group becomes its own pseudo-TFM so versions are
    /// not lost. A package whose condition matched none of the project's TFMs is returned with
    /// <c>Matched: false</c> so consumers warn instead of showing a wrong version.
    /// </summary>
    public static Dictionary<string, List<CpmVersionResolution>> ResolveVersions(
        CpmPackageMap map,
        IEnumerable<string> packageIds,
        IEnumerable<string> tfms)
    {
        ArgumentNullException.ThrowIfNull(map);
        ArgumentNullException.ThrowIfNull(packageIds);
        ArgumentNullException.ThrowIfNull(tfms);

        var result = new Dictionary<string, List<CpmVersionResolution>>(StringComparer.Ordinal);
        var uniqueTfms = tfms
            .Select(tfm => tfm.Trim())
            .Where(tfm => tfm.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .ToList();

        foreach (var packageId in packageIds.Distinct(StringComparer.Ordinal))
        {
            // CA1859: the concrete list keeps the analyzer happy and avoids interface dispatch.
            List<CpmVersionResolution> candidates = uniqueTfms.Count == 0
                ? UnconditionalAndConditionalResolutions(packageId, map)
                : [.. uniqueTfms
                    .Select(tfm => ResolutionForTfm(packageId, tfm, map))
                    .OfType<CpmVersionResolution>()];

            if (candidates.Count == 0 && uniqueTfms.Count > 0)
            {
                candidates = UnknownResolutions(packageId, map, uniqueTfms);
            }

            // One row per version line: a condition matching several TFMs is still one line.
            var seenConditions = new HashSet<string>(StringComparer.Ordinal);
            List<CpmVersionResolution> resolutions =
                [.. candidates.Where(resolution => seenConditions.Add(resolution.Condition))];

            if (resolutions.Count > 0)
            {
                result[packageId] = resolutions;
            }
        }

        return result;
    }

    public static bool HasPackage(CpmPackageMap map, string packageId)
    {
        ArgumentNullException.ThrowIfNull(map);
        ArgumentException.ThrowIfNullOrEmpty(packageId);

        return FindCaseInsensitive(map.Unconditional, packageId) is not null
            || map.Conditional.Any(entry => FindCaseInsensitive(entry.Versions, packageId) is not null);
    }

    private static List<CpmVersionResolution> UnconditionalAndConditionalResolutions(
        string packageId,
        CpmPackageMap map)
    {
        var resolutions = new List<CpmVersionResolution>();

        var unconditionalVersion = FindCaseInsensitive(map.Unconditional, packageId);
        if (unconditionalVersion is not null)
        {
            resolutions.Add(UnconditionalResolution(packageId, unconditionalVersion));
        }

        foreach (var entry in map.Conditional)
        {
            var version = FindCaseInsensitive(entry.Versions, packageId);
            if (version is not null)
            {
                resolutions.Add(ConditionalResolution(packageId, entry.Framework, version, entry, matched: true));
            }
        }

        return resolutions;
    }

    /// <summary>The version one framework resolves to, or null when neither a condition nor the shared line applies.</summary>
    private static CpmVersionResolution? ResolutionForTfm(string packageId, string tfm, CpmPackageMap map)
    {
        var winner = map.Conditional
            .Where(entry => CpmCondition.Evaluate(entry.Condition, TfmVariables(tfm)) == true)
            .Where(entry => FindCaseInsensitive(entry.Versions, packageId) is not null)
            .OrderBy(entry => entry.Order)
            .LastOrDefault();

        var winnerVersion = winner is null ? null : FindCaseInsensitive(winner.Versions, packageId);
        if (winner is not null && winnerVersion is not null)
        {
            return ConditionalResolution(packageId, tfm, winnerVersion, winner, matched: true);
        }

        // Unconditional versions are shared across TFMs: one row only.
        var unconditionalVersion = FindCaseInsensitive(map.Unconditional, packageId);
        return unconditionalVersion is null
            ? null
            : UnconditionalResolution(packageId, unconditionalVersion);
    }

    private static List<CpmVersionResolution> UnknownResolutions(
        string packageId,
        CpmPackageMap map,
        IReadOnlyList<string> uniqueTfms)
    {
        // Nothing matched. Fall back only for conditions that could not be evaluated at all: a
        // condition that evaluated to false belongs to a different framework line and must not
        // be shown here.
        var resolutions = new List<CpmVersionResolution>();
        foreach (var entry in map.Conditional)
        {
            var version = FindCaseInsensitive(entry.Versions, packageId);
            if (version is null)
            {
                continue;
            }

            var unknown = uniqueTfms.Any(tfm => CpmCondition.Evaluate(entry.Condition, TfmVariables(tfm)) is null);
            if (unknown)
            {
                resolutions.Add(ConditionalResolution(packageId, entry.Framework, version, entry, matched: false));
            }
        }

        return resolutions;
    }

    private static Dictionary<string, string> TfmVariables(string tfm) =>
        new() { ["TargetFramework"] = tfm };

    private static CpmVersionResolution UnconditionalResolution(string packageId, string version) =>
        new(packageId, string.Empty, version, string.Empty, string.Empty, true);

    private static CpmVersionResolution ConditionalResolution(
        string packageId,
        string tfm,
        string version,
        CpmFrameworkEntry entry,
        bool matched) =>
        new(packageId, tfm, version, entry.Condition, entry.Framework, matched);

    private static IEnumerable<XElement> ItemGroups(string content) =>
        XDocument.Parse(content)
            .Descendants()
            .Where(element => element.Name.LocalName == "ItemGroup");

    /// <summary>A <c>PropertyGroup</c> property value, trimmed.</summary>
    private static string? PropertyValue(string content, string propertyName) =>
        XDocument.Parse(content)
            .Descendants()
            .Where(element => element.Name.LocalName == propertyName)
            .Select(element => element.Value.Trim())
            .FirstOrDefault();

    private static string CombineConditions(string groupCondition, string elementCondition)
    {
        if (groupCondition.Length == 0)
        {
            return elementCondition;
        }

        return elementCondition.Length == 0
            ? groupCondition
            : $"({groupCondition}) And ({elementCondition})";
    }

    private static string? FindCaseInsensitive(Dictionary<string, string> map, string key)
    {
        if (map.TryGetValue(key, out var exact))
        {
            return exact;
        }

        foreach (var (existingKey, value) in map)
        {
            if (string.Equals(existingKey, key, StringComparison.OrdinalIgnoreCase))
            {
                return value;
            }
        }

        return null;
    }
}
