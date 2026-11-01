using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace NugetPackageManager.Core.Diagnostics;

/// <summary>Facts the host supplies about the invocation being classified.</summary>
public sealed record DotnetFailureContext(
    string? ProjectPath = null,
    string? PinnedSdkVersion = null,
    string? GlobalJsonPath = null,
    bool SpawnFailed = false);

/// <summary>Structured failure as it crosses the RPC boundary (<c>DotnetFailureInfo</c>).</summary>
public sealed record DotnetFailureInfo
{
    [JsonPropertyName("Kind")]
    public required string Kind { get; init; }

    [JsonPropertyName("Summary")]
    public required string Summary { get; init; }

    [JsonPropertyName("Hint")]
    public required string Hint { get; init; }

    [JsonPropertyName("Detail")]
    public required string Detail { get; init; }

    [JsonPropertyName("Conflicts")]
    public IReadOnlyList<RestoreConflictInfo>? Conflicts { get; init; }

    [JsonPropertyName("SdkVersion")]
    public string? SdkVersion { get; init; }

    [JsonPropertyName("GlobalJsonPath")]
    public string? GlobalJsonPath { get; init; }

    [JsonPropertyName("PinnedSdkVersion")]
    public string? PinnedSdkVersion { get; init; }

    [JsonPropertyName("ProjectPath")]
    public string? ProjectPath { get; init; }
}

/// <summary>
/// Classifies the output of a failed <c>dotnet</c> invocation into a cause the UI can explain.
///
/// Restore output is not a single error: a broken SDK resolves to a multi-line MSB4242 stack
/// that looks like a package problem, a NU1107 graph failure names packages, and a missing
/// <c>global.json</c> SDK looks like "restore failed". The classifier keeps the raw text but
/// adds a kind, a one-line summary and a matching hint, so callers never show the stack.
/// </summary>
public static partial class DotnetFailureClassifier
{
    private const int MaxDetailLines = 60;

    public static DotnetFailureInfo Classify(string output, DotnetFailureContext? context = null)
    {
        ArgumentNullException.ThrowIfNull(output);
        context ??= new DotnetFailureContext();

        var parsed = RestoreOutput.Parse(output);
        var baseInfo = new FailureBase
        {
            Detail = DetailFrom(output),
            Conflicts = parsed,
            SdkVersion = ExtractSdkVersion(output),
            GlobalJsonPath = context.GlobalJsonPath,
            PinnedSdkVersion = context.PinnedSdkVersion,
            ProjectPath = context.ProjectPath,
        };

        return ClassifySdkFailure(output, baseInfo, context)
            ?? ClassifyVulnerabilityAudit(output, baseInfo)
            ?? ClassifyRestoreFailure(output, baseInfo)
            ?? ClassifyEnvironmentFailure(output, baseInfo)
            ?? UnknownFailure(output, baseInfo);
    }

    /// <summary>One-line log/debug form.</summary>
    public static string Describe(DotnetFailureInfo failure)
    {
        ArgumentNullException.ThrowIfNull(failure);

        var project = failure.ProjectPath is null ? string.Empty : $" [{failure.ProjectPath}]";
        return $"{failure.Kind}: {failure.Summary}{project} — {failure.Hint}";
    }

    private static DotnetFailureInfo? ClassifySdkFailure(
        string output,
        FailureBase baseInfo,
        DotnetFailureContext context)
    {
        var pinned = context.PinnedSdkVersion;
        var sdkLabel = baseInfo.SdkVersion is null ? string.Empty : $" {baseInfo.SdkVersion}";

        if (context.SpawnFailed
            || (DotnetMissing().IsMatch(output) && !SdkResolution().IsMatch(output)))
        {
            return Build(
                baseInfo,
                "DotnetMissing",
                "The dotnet CLI could not be started.",
                "Install the .NET SDK and make sure `dotnet` is on PATH, then reload the window.");
        }

        if (WorkloadConflict().IsMatch(output))
        {
            var pack = ExtractConflictingPack(output);
            var packLabel = pack is null ? string.Empty : $" ({pack})";
            return Build(
                baseInfo,
                "WorkloadManifestConflict",
                $"The .NET SDK{sdkLabel} on this machine has conflicting workload manifests{packLabel}.",
                $"This is a machine-level .NET SDK problem, not a package problem.{PinnedSuffix(pinned)} Use \"Update workloads\" on the Toolchain tab (or run `dotnet workload update` in an elevated terminal); if it persists, repair or remove that SDK.");
        }

        if (SdkResolution().IsMatch(output))
        {
            return Build(
                baseInfo,
                "SdkResolutionFailure",
                $"The .NET SDK{sdkLabel} could not resolve its SDK components.",
                $"Run `dotnet workload repair` or reinstall the SDK used by this solution.{PinnedSuffix(pinned)}");
        }

        var missingPinned = PinnedSdkMissing().Match(output);
        if (!missingPinned.Success)
        {
            return null;
        }

        var version = missingPinned.Groups[1].Success && missingPinned.Groups[1].Value.Length > 0
            ? missingPinned.Groups[1].Value
            : pinned;
        var versionLabel = version is null ? string.Empty : $" {version}";
        return Build(
            baseInfo,
            "PinnedSdkMissing",
            $"The .NET SDK{versionLabel} required by global.json is not installed.",
            "Install that SDK version, or update `sdk.version` in global.json to one that is installed.");
    }

    private static DotnetFailureInfo? ClassifyVulnerabilityAudit(string output, FailureBase baseInfo)
    {
        if (!VulnerabilityAudit().IsMatch(output))
        {
            return null;
        }

        var packages = new List<string>();
        var advisories = new List<string>();

        foreach (Match match in VulnerablePackage().Matches(output))
        {
            packages.Add($"{match.Groups[1].Value} {match.Groups[2].Value} ({match.Groups[3].Value})");
            var advisory = match.Groups[4];
            if (advisory.Success)
            {
                advisories.Add(TrimTrailingPunctuation(advisory.Value));
            }
        }

        var listed = string.Join(
            ", ",
            packages.Distinct(StringComparer.Ordinal).Take(5));
        var firstAdvisory = advisories.Distinct(StringComparer.Ordinal).FirstOrDefault();
        var listedSuffix = listed.Length > 0 ? $": {listed}" : string.Empty;
        var advisorySuffix = firstAdvisory is null ? string.Empty : $". Advisory: {firstAdvisory}";

        return Build(
            baseInfo,
            "VulnerabilityAudit",
            $"The vulnerability audit fails the build{listedSuffix}.",
            $"NuGetAudit is enabled and NU190x is promoted to an error by WarningsAsErrors. Update the affected package (as a transitive dependency, raise the direct parent or add a central pin to a patched version), or stop promoting NU190x{advisorySuffix}.");
    }

    private static DotnetFailureInfo? ClassifyRestoreFailure(string output, FailureBase baseInfo)
    {
        if (baseInfo.Conflicts.Count == 0)
        {
            return null;
        }

        return Build(
            baseInfo,
            "RestoreConflict",
            RestoreOutput.Summarize(output) ?? "Package restore failed with a dependency conflict.",
            "Pin the contested package to a single version (the Consolidate tab can do this) and restore again.");
    }

    /// <summary>Feed and credential causes: the restore never reached package resolution.</summary>
    private static DotnetFailureInfo? ClassifyEnvironmentFailure(string output, FailureBase baseInfo)
    {
        if (SourceUnavailable().IsMatch(output))
        {
            return Build(
                baseInfo,
                "SourceUnavailable",
                "A NuGet source could not be reached.",
                "Check the source URL, network/proxy settings and feed credentials, then restore again.");
        }

        if (!PasswordScript().IsMatch(output))
        {
            return null;
        }

        return Build(
            baseInfo,
            "PasswordScriptFailed",
            "The password script did not supply a usable credential.",
            "Run the script manually, check that the allowlist path is correct, and confirm it prints the password to stdout.");
    }

    private static DotnetFailureInfo UnknownFailure(string output, FailureBase baseInfo) =>
        Build(
            baseInfo,
            "Unknown",
            RestoreOutput.Summarize(output) ?? "dotnet failed without a recognizable error.",
            "Open the NuGet Package Manager output channel for the full command output.");

    private static DotnetFailureInfo Build(
        FailureBase baseInfo,
        string kind,
        string summary,
        string hint) =>
        new()
        {
            Kind = kind,
            Summary = summary,
            Hint = hint,
            Detail = baseInfo.Detail,
            Conflicts = baseInfo.Conflicts.Count > 0 ? RestoreOutput.ToWire(baseInfo.Conflicts) : null,
            SdkVersion = baseInfo.SdkVersion,
            GlobalJsonPath = baseInfo.GlobalJsonPath,
            PinnedSdkVersion = baseInfo.PinnedSdkVersion,
            ProjectPath = baseInfo.ProjectPath,
        };

    /// <summary><c>10.0.403</c> or <c>11.0.100-rc.3.26522.148</c>: digits, dots and a suffix.</summary>
    private static bool IsSdkVersionSegment(string value)
    {
        var dots = 0;
        var digits = 0;

        foreach (var character in value)
        {
            var isDigit = character is >= '0' and <= '9';
            var isLetter = character is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z');
            if (isDigit)
            {
                digits++;
            }
            else if (character == '.')
            {
                dots++;
            }
            else if (!isLetter && character != '-' && character != '_')
            {
                return false;
            }
        }

        return digits > 0 && dots >= 2;
    }

    private static string? ExtractSdkVersion(string output)
    {
        // MSBuild paths mix separators; split them instead of backtracking over them.
        var segments = output.Replace('\\', '/').Split('/');
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (!string.Equals(segments[index], "sdk", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var candidate = segments[index + 1];
            if (IsSdkVersionSegment(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static string? ExtractConflictingPack(string output)
    {
        var match = ConflictingPack().Match(output);
        return match.Success ? $"{match.Groups[1].Value} ({match.Groups[2].Value})" : null;
    }

    private static List<string> ErrorLines(string output) =>
        [.. output
            .Split('\n')
            .Select(line => line.TrimEnd('\r').Trim())
            .Where(line => AnyErrorLine().IsMatch(line))
            .Select(line => ErrorPathPrefix().Replace(line, string.Empty))
            .Distinct(StringComparer.Ordinal)];

    private static string DetailFrom(string output)
    {
        var errors = ErrorLines(output);
        var source = errors.Count > 0
            ? errors
            : [.. output.Split('\n').Select(line => line.TrimEnd('\r').Trim()).Where(line => line.Length > 0)];

        return string.Join("\n", source.Take(MaxDetailLines));
    }

    private static string PinnedSuffix(string? pinned) =>
        pinned is null ? string.Empty : $" This solution pins SDK {pinned} in global.json.";

    private static string TrimTrailingPunctuation(string value)
    {
        var end = value.Length;
        while (end > 0 && value[end - 1] is '.' or ',' or ';')
        {
            end--;
        }

        return end == value.Length ? value : value[..end];
    }

    private sealed class FailureBase
    {
        public required string Detail { get; init; }

        public required IReadOnlyList<RestoreConflict> Conflicts { get; init; }

        public string? SdkVersion { get; init; }

        public string? GlobalJsonPath { get; init; }

        public string? PinnedSdkVersion { get; init; }

        public string? ProjectPath { get; init; }
    }

    [GeneratedRegex(
        @"WorkloadManifestCompositionException|Workload pack '[^']+' in manifest '[^']+' conflicts",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex WorkloadConflict();

    [GeneratedRegex(@"\bMSB4242\b|SDK Resolver Failure", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SdkResolution();

    [GeneratedRegex(
        @"\bMSB4236\b|The SDK '([^']+)' specified could not be found|A compatible \.NET SDK .* was not found",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PinnedSdkMissing();

    [GeneratedRegex(@"NU190[0-5]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex VulnerabilityAudit();

    [GeneratedRegex(
        @"Package '([^']+)' ([^\s]+) has a known (\w+) severity vulnerability,?\s*(https?://\S+)?",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex VulnerablePackage();

    [GeneratedRegex(
        @"\bNU1301\b|\bNU1801\b|Unable to load the service index|No such host is known|ECONNREFUSED|ETIMEDOUT|407 Proxy Authentication",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SourceUnavailable();

    [GeneratedRegex(
        @"password script|credential provider .*failed",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PasswordScript();

    [GeneratedRegex(
        @"ENOENT|not recognized as an internal or external command|command not found|No such file or directory",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DotnetMissing();

    [GeneratedRegex(@"Workload pack '([^']+)' in manifest '([^']+)'", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ConflictingPack();

    [GeneratedRegex(@"\berror\s+[A-Z]+\d+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex AnyErrorLine();

    [GeneratedRegex(@"^.*?\s:\s(?=error\s)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ErrorPathPrefix();
}
