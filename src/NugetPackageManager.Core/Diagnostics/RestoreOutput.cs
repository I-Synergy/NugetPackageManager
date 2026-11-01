using System.Text.RegularExpressions;

namespace NugetPackageManager.Core.Diagnostics;

/// <summary>
/// Parser for the version-conflict diagnostics emitted by <c>dotnet restore</c>.
///
/// The restore output is the only authoritative description of why a package graph cannot be
/// resolved, so the constraint chains are kept instead of collapsing the failure into
/// "there may be version conflicts".
/// </summary>
public static partial class RestoreOutput
{
    private const int MaxSummaryLines = 5;
    private const int MaxTailLines = 3;

    /// <summary>Parses every recognized <c>NUxxxx</c> diagnostic in a restore output.</summary>
    public static IReadOnlyList<RestoreConflict> Parse(string output)
    {
        ArgumentNullException.ThrowIfNull(output);

        var conflicts = new List<RestoreConflict>();
        RestoreConflict? current = null;

        foreach (var rawLine in SplitLines(output))
        {
            var sanitized = PathPrefix().Replace(rawLine, string.Empty, 1);
            var error = ErrorLine().Match(sanitized);
            if (error.Success)
            {
                current = ParseHead(
                    error.Groups[1].Value.ToUpperInvariant(),
                    error.Groups[2].Value.Trim());
                conflicts.Add(current);
                continue;
            }

            if (current is null || sanitized.Trim().Length == 0)
            {
                continue;
            }

            if (sanitized.Contains("->", StringComparison.Ordinal))
            {
                var constraint = ExtractConstraint(sanitized);
                if (constraint is not null)
                {
                    current.Constraints.Add(constraint);
                }

                continue;
            }

            // A non-chain line ends the current diagnostic block.
            current = null;
        }

        // Some SDK versions print the same chain twice.
        foreach (var conflict in conflicts)
        {
            var seen = new HashSet<(string, string)>();
            conflict.Constraints.RemoveAll(constraint => !seen.Add((constraint.Chain, constraint.Range)));
        }

        return conflicts;
    }

    public static List<RestoreConflictInfo> ToWire(IReadOnlyList<RestoreConflict> conflicts) =>
        [.. conflicts.Select(conflict => new RestoreConflictInfo
        {
            Code = conflict.Code,
            PackageId = conflict.PackageId,
            SuggestedVersion = conflict.SuggestedVersion,
            Message = conflict.Message,
            Chains = [.. conflict.Constraints.Select(constraint => constraint.Chain)],
        })];

    /// <summary>Formats parsed conflicts into one actionable sentence for the UI.</summary>
    public static string Format(IReadOnlyList<RestoreConflict> conflicts)
    {
        ArgumentNullException.ThrowIfNull(conflicts);

        var entries = conflicts.Select(conflict =>
        {
            var head = conflict.PackageId.Length > 0
                ? $"{conflict.Code} {conflict.PackageId}"
                : conflict.Code;
            var chains = string.Join("; ", conflict.Constraints.Select(constraint => constraint.Chain));
            return chains.Length > 0 ? $"{head} — {chains}" : $"{head} — {conflict.Message}";
        });

        return string.Join(" | ", entries.Distinct(StringComparer.Ordinal));
    }

    /// <summary>
    /// Best-effort human summary: parsed conflicts when the diagnostic is recognized,
    /// otherwise the most relevant error lines.
    /// </summary>
    public static string? Summarize(string output)
    {
        ArgumentNullException.ThrowIfNull(output);

        var conflicts = Parse(output);
        if (conflicts.Count > 0)
        {
            return Format(conflicts);
        }

        var errorLines = SplitLines(output)
            .Select(line => line.Trim())
            .Where(line => AnyErrorLine().IsMatch(line))
            .Select(line => ErrorPathPrefix().Replace(line, string.Empty))
            .Distinct(StringComparer.Ordinal)
            .Take(MaxSummaryLines)
            .ToList();

        if (errorLines.Count > 0)
        {
            return string.Join(" | ", errorLines);
        }

        var tail = SplitLines(output)
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .TakeLast(MaxTailLines)
            .ToList();

        return tail.Count > 0 ? string.Join(" | ", tail) : null;
    }

    private static RestoreConflict ParseHead(string code, string message)
    {
        var conflict = new RestoreConflict { Code = code, Message = message };

        if (code == "NU1107")
        {
            var package = Nu1107Package().Match(message);
            if (package.Success)
            {
                conflict.PackageId = package.Groups[1].Value.Trim();
            }

            var install = Nu1107Install().Match(message);
            if (install.Success)
            {
                conflict.SuggestedVersion = install.Groups[2].Value.Trim();
                conflict.ProjectName = install.Groups[3].Value.Trim();
            }
        }
        else if (code is "NU1605" or "NU1109")
        {
            var downgrade = Downgrade().Match(message);
            if (downgrade.Success)
            {
                conflict.PackageId = downgrade.Groups[1].Value.Trim();
                conflict.SuggestedVersion = downgrade.Groups[2].Value.Trim();
            }
        }
        else if (code == "NU1608")
        {
            var outside = OutsideConstraint().Match(message);
            if (outside.Success)
            {
                conflict.PackageId = outside.Groups[1].Value.Trim();
            }
        }
        else if (code == "NU1102")
        {
            var missing = MissingPackage().Match(message);
            if (missing.Success)
            {
                conflict.PackageId = missing.Groups[1].Value.Trim();
            }
        }

        return conflict;
    }

    private static RestoreConstraint? ExtractConstraint(string sanitized)
    {
        if (!sanitized.Contains(" -> ", StringComparison.Ordinal))
        {
            return null;
        }

        var chain = TrailingDot().Replace(Whitespace().Replace(sanitized.Trim(), " "), string.Empty);
        var range = TrailingRange().Match(chain);
        return new RestoreConstraint(chain, range.Success ? range.Groups[1].Value.Trim() : string.Empty);
    }

    private static IEnumerable<string> SplitLines(string output) =>
        output.Split('\n').Select(line => line.TrimEnd('\r'));

    [GeneratedRegex(@"\berror\s+(NU\d{4})\s*:\s*(.*)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ErrorLine();

    [GeneratedRegex(@"^.*?\s:\s", RegexOptions.CultureInvariant)]
    private static partial Regex PathPrefix();

    [GeneratedRegex(@"\(([^()]+)\)\s*\.?$", RegexOptions.CultureInvariant)]
    private static partial Regex TrailingRange();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"\.$", RegexOptions.CultureInvariant)]
    private static partial Regex TrailingDot();

    [GeneratedRegex(@"\berror\s+[A-Z]+\d+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AnyErrorLine();

    [GeneratedRegex(@"^.*?\s:\s(?=error\s)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ErrorPathPrefix();

    [GeneratedRegex(@"Version conflict detected for (.+?)\.\s", RegexOptions.CultureInvariant)]
    private static partial Regex Nu1107Package();

    [GeneratedRegex(
        @"Install/reference (.+?) (\S+) directly to project (.+?) to resolve",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Nu1107Install();

    [GeneratedRegex(
        @"Detected package downgrade: (.+?) from (\S+) to (\S+)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Downgrade();

    [GeneratedRegex(
        @"Detected package version outside of dependency constraint: .+? \S+ requires (.+?) \(([^)]+)\)",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex OutsideConstraint();

    [GeneratedRegex(@"Unable to find package (.+?) with version", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex MissingPackage();
}
