using System.Text.Json;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// Pure JSON → DTO mapping for the NuGet v3 search, registration and catalog payloads.
///
/// Kept free of I/O so the shapes can be asserted directly against recorded payloads: the
/// DTO leaks registration leaf URLs, so the mapping has to reproduce them exactly.
/// </summary>
public static class PackageMapping
{
    /// <summary>Maps a <c>SearchQueryService</c> response (<c>data[]</c>).</summary>
    public static List<PackageDto> MapSearch(JsonElement root)
    {
        var results = new List<PackageDto>();
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Array)
        {
            return results;
        }

        foreach (var item in data.EnumerateArray())
        {
            results.Add(new PackageDto
            {
                Id = Text(item, "@id"),
                Name = Text(item, "id"),
                Authors = StringOrArray(item, "authors"),
                Description = Text(item, "description"),
                IconUrl = Text(item, "iconUrl"),
                LicenseUrl = Text(item, "licenseUrl"),
                ProjectUrl = Text(item, "projectUrl"),
                Registration = Text(item, "registration"),
                TotalDownloads = Number(item, "totalDownloads"),
                Verified = Boolean(item, "verified"),
                InstalledVersion = string.Empty,
                Version = Text(item, "version"),
                Versions = MapSearchVersions(item),
                Tags = StringOrArray(item, "tags"),
            });
        }

        return results;
    }

    /// <summary>
    /// Maps the registration index for one package to a <see cref="PackageDto"/>.
    /// Returns null when the index carries no versions.
    /// </summary>
    /// <param name="leaves">The registration leaves, already flattened across pages.</param>
    /// <param name="prerelease">Whether prerelease versions are eligible.</param>
    public static PackageDto? MapRegistration(IReadOnlyList<JsonElement> leaves, bool prerelease)
    {
        ArgumentNullException.ThrowIfNull(leaves);

        var selected = SelectVersions(leaves, prerelease);
        if (selected.Count == 0)
        {
            return null;
        }

        var latest = selected[^1];
        var entry = CatalogEntry(latest);

        return new PackageDto
        {
            Id = Text(latest, "@id"),
            Name = entry is null ? string.Empty : Text(entry.Value, "id"),
            Authors = entry is null ? [] : StringOrArray(entry.Value, "authors"),
            Description = entry is null ? string.Empty : Text(entry.Value, "description"),
            IconUrl = entry is null ? string.Empty : Text(entry.Value, "iconUrl"),
            LicenseUrl = entry is null ? string.Empty : Text(entry.Value, "licenseUrl"),
            ProjectUrl = entry is null ? string.Empty : Text(entry.Value, "projectUrl"),
            Registration = entry is null ? string.Empty : Text(entry.Value, "registration"),
            TotalDownloads = entry is null ? 0 : Number(entry.Value, "totalDownloads"),
            Verified = entry is not null && Boolean(entry.Value, "verified"),
            InstalledVersion = string.Empty,
            Version = entry is null ? string.Empty : Text(entry.Value, "version"),
            Versions = [.. selected.Select(leaf => new PackageVersionRef
            {
                Version = CatalogEntry(leaf) is { } catalog ? Text(catalog, "version") : string.Empty,
                Id = Text(leaf, "@id"),
            })],
            Tags = entry is null ? [] : StringOrArray(entry.Value, "tags"),
        };
    }

    /// <summary>Maps a catalog entry's <c>dependencyGroups</c> (<c>PackageDetails</c>).</summary>
    public static PackageDetailsDto MapDependencyGroups(JsonElement catalogEntry)
    {
        var frameworks = new Dictionary<string, List<PackageDependencyDto>>(StringComparer.Ordinal);

        if (catalogEntry.ValueKind == JsonValueKind.Object
            && catalogEntry.TryGetProperty("dependencyGroups", out var groups)
            && groups.ValueKind == JsonValueKind.Array)
        {
            foreach (var group in groups.EnumerateArray())
            {
                var dependencies = new List<PackageDependencyDto>();

                if (group.TryGetProperty("dependencies", out var items) && items.ValueKind == JsonValueKind.Array)
                {
                    foreach (var dependency in items.EnumerateArray())
                    {
                        dependencies.Add(new PackageDependencyDto
                        {
                            Package = Text(dependency, "id"),
                            VersionRange = Text(dependency, "range"),
                        });
                    }
                }

                // The existing contract drops empty groups: the UI treats a missing framework
                // as "no dependencies declared".
                if (dependencies.Count > 0)
                {
                    frameworks[Text(group, "targetFramework")] = dependencies;
                }
            }
        }

        return new PackageDetailsDto
        {
            Dependencies = new PackageDependencyGroupDto { Frameworks = frameworks },
        };
    }

    /// <summary>The embedded catalog entry of a registration leaf, when it is an object.</summary>
    public static JsonElement? CatalogEntry(JsonElement leaf) =>
        leaf.ValueKind == JsonValueKind.Object
        && leaf.TryGetProperty("catalogEntry", out var entry)
        && entry.ValueKind == JsonValueKind.Object
            ? entry
            : null;

    /// <summary>
    /// Drops prerelease versions unless they were asked for. When every version is a
    /// prerelease the full list is kept: the package exists, the filter is just too strict.
    /// </summary>
    private static List<JsonElement> SelectVersions(IReadOnlyList<JsonElement> leaves, bool prerelease)
    {
        var all = leaves
            .Where(leaf => leaf.ValueKind == JsonValueKind.Object && leaf.TryGetProperty("@id", out _))
            .ToList();

        if (prerelease)
        {
            return SortByVersion(all);
        }

        var stable = all
            .Where(leaf => !VersionOf(leaf).Contains('-', StringComparison.Ordinal))
            .ToList();

        return SortByVersion(stable.Count > 0 ? stable : all);
    }

    private static List<JsonElement> SortByVersion(List<JsonElement> leaves)
    {
        var sorted = new List<JsonElement>(leaves);
        sorted.Sort((left, right) => CompareVersions(VersionOf(left), VersionOf(right)));
        return sorted;
    }

    private static string VersionOf(JsonElement leaf) =>
        CatalogEntry(leaf) is { } entry ? Text(entry, "version") : string.Empty;

    /// <summary>
    /// NuGet's version ordering, matching the TypeScript comparator: numeric segments first,
    /// a prerelease sorts before its release, and prerelease identifiers compare segment by
    /// segment with numeric identifiers ordered numerically.
    /// </summary>
    public static int CompareVersions(string left, string right)
    {
        var (leftRelease, leftPre) = SplitVersion(left);
        var (rightRelease, rightPre) = SplitVersion(right);

        var release = CompareNumeric(leftRelease, rightRelease);
        return release != 0 ? release : ComparePrerelease(leftPre, rightPre);
    }

    private static (string Release, string Prerelease) SplitVersion(string value)
    {
        var clean = value.Replace("[", string.Empty, StringComparison.Ordinal)
            .Replace("]", string.Empty, StringComparison.Ordinal)
            .Replace("(", string.Empty, StringComparison.Ordinal)
            .Replace(")", string.Empty, StringComparison.Ordinal)
            .Split('+')[0];

        var dash = clean.IndexOf('-', StringComparison.Ordinal);
        return dash < 0
            ? (clean, string.Empty)
            : (clean[..dash], clean[(dash + 1)..]);
    }

    private static int CompareNumeric(string left, string right)
    {
        var leftParts = left.Split('.');
        var rightParts = right.Split('.');
        var length = Math.Max(leftParts.Length, rightParts.Length);

        for (var index = 0; index < length; index++)
        {
            var leftValue = ParsePart(index < leftParts.Length ? leftParts[index] : "0");
            var rightValue = ParsePart(index < rightParts.Length ? rightParts[index] : "0");
            if (leftValue != rightValue)
            {
                return leftValue < rightValue ? -1 : 1;
            }
        }

        return 0;
    }

    private static int ComparePrerelease(string left, string right)
    {
        if (left.Length == 0 && right.Length == 0)
        {
            return 0;
        }

        // A release is newer than any prerelease of the same version.
        if (left.Length == 0)
        {
            return 1;
        }

        if (right.Length == 0)
        {
            return -1;
        }

        var leftParts = left.Split('.');
        var rightParts = right.Split('.');
        var length = Math.Min(leftParts.Length, rightParts.Length);

        for (var index = 0; index < length; index++)
        {
            var leftPart = leftParts[index];
            var rightPart = rightParts[index];
            var leftIsNumber = long.TryParse(leftPart, out var leftNumber);
            var rightIsNumber = long.TryParse(rightPart, out var rightNumber);

            if (leftIsNumber && rightIsNumber)
            {
                if (leftNumber != rightNumber)
                {
                    return leftNumber < rightNumber ? -1 : 1;
                }

                continue;
            }

            // Numeric identifiers sort before alphanumeric ones.
            if (leftIsNumber)
            {
                return -1;
            }

            if (rightIsNumber)
            {
                return 1;
            }

            var comparison = string.CompareOrdinal(leftPart, rightPart);
            if (comparison != 0)
            {
                return comparison < 0 ? -1 : 1;
            }
        }

        return leftParts.Length.CompareTo(rightParts.Length);
    }

    private static long ParsePart(string value) =>
        long.TryParse(value, out var parsed) ? parsed : 0;

    private static List<PackageVersionRef> MapSearchVersions(JsonElement item)
    {
        var versions = new List<PackageVersionRef>();

        if (item.ValueKind == JsonValueKind.Object
            && item.TryGetProperty("versions", out var list)
            && list.ValueKind == JsonValueKind.Array)
        {
            foreach (var version in list.EnumerateArray())
            {
                versions.Add(new PackageVersionRef
                {
                    Version = Text(version, "version"),
                    Id = Text(version, "@id"),
                });
            }
        }

        return versions;
    }

    private static string Text(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString() ?? string.Empty
            : string.Empty;

    private static long Number(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt64(out var parsed)
            ? parsed
            : 0;

    private static bool Boolean(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.True;

    private static List<string> StringOrArray(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(property, out var value))
        {
            return [];
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return [value.GetString() ?? string.Empty];
        }

        if (value.ValueKind == JsonValueKind.Array)
        {
            return [.. value.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString() ?? string.Empty)];
        }

        return [];
    }
}
