using System.Text.Json;
using System.Text.RegularExpressions;
using NuGet.Versioning;
using NugetPackageManager.Core.Diagnostics;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>
/// Turns captured <c>dotnet</c> output into toolchain findings. The host still spawns every
/// command (progress, cancellation, the private install); this class only parses and decides.
/// </summary>
public static partial class ToolchainAnalysis
{
    public static ToolchainHealthInfo Evaluate(ToolchainProbeInput input)
    {
        ArgumentNullException.ThrowIfNull(input);

        var installedSdks = MergeInstalledSdks(ParseSdkList(input.SdkList.Stdout), input.PrivateSdkVersions);
        var issues = new List<ToolchainIssueInfo>();
        var localTools = EvaluateLocalTools(input.LocalTools);
        var sdkVersion = ReadCommandVersion(input.Version);

        if (sdkVersion is null)
        {
            var failure = DotnetFailureClassifier.Classify(
                JoinOutput(input.Version.Stderr, input.Version.Stdout),
                new DotnetFailureContext(
                    ProjectPath: input.ProjectPath,
                    PinnedSdkVersion: input.PinnedSdkVersion,
                    GlobalJsonPath: input.GlobalJsonPath,
                    SpawnFailed: input.Version.SpawnError is not null));

            issues.Add(ToIssue(failure));
            issues.AddRange(localTools.Issues);

            return new ToolchainHealthInfo
            {
                DotnetFound = input.Version.SpawnError is null,
                DotnetPath = DotnetPath(input),
                GlobalJsonPath = input.GlobalJsonPath,
                PinnedSdkVersion = input.PinnedSdkVersion,
                ProjectEvaluationFailed = false,
                CheckedAt = input.CheckedAt,
                InstalledSdks = installedSdks,
                LocalToolManifests = localTools.Manifests,
                LocalToolsNotRestored = localTools.NotRestored,
                Issues = issues,
            };
        }

        var sdkMatchesPin = CheckPinMatch(input, sdkVersion, issues);
        var evaluation = EvaluateProject(input, sdkVersion, issues);
        var orphanedBands = DetectBands(installedSdks, issues);
        issues.AddRange(localTools.Issues);

        var sdkCheck = ParseSdkCheck(input.SdkCheckOutput ?? string.Empty);
        var sdkStatus = FindSdkStatus(sdkCheck, sdkVersion);

        return new ToolchainHealthInfo
        {
            DotnetFound = true,
            SdkVersion = sdkVersion,
            BuildSdkVersion = evaluation.BuildSdkVersion,
            SdkStatus = sdkStatus,
            SdkCheckUnavailable = sdkCheck.Unavailable,
            OrphanedManifestBands = orphanedBands.Count > 0
                ? [.. orphanedBands.Select(band => band.Path)]
                : null,
            DotnetPath = DotnetPath(input),
            GlobalJsonPath = input.GlobalJsonPath,
            PinnedSdkVersion = input.PinnedSdkVersion,
            SdkMatchesPin = sdkMatchesPin,
            ProjectEvaluationFailed = evaluation.Failed,
            CheckedAt = input.CheckedAt,
            InstalledSdks = installedSdks,
            LocalToolManifests = localTools.Manifests,
            LocalToolsNotRestored = localTools.NotRestored,
            Issues = issues,
        };
    }

    /// <summary>Whether <paramref name="sdk"/> is acceptable for <paramref name="pinned"/>.</summary>
    public static bool SdkSatisfiesPin(string sdk, string pinned, string? rollForward)
    {
        if (sdk == pinned)
        {
            return true;
        }

        var roll = (rollForward ?? "latestPatch").ToLowerInvariant();
        if (roll == "disable")
        {
            return false;
        }

        if (roll == "latestMajor")
        {
            return true;
        }

        return sdk.Split('.')[0] == pinned.Split('.')[0];
    }

    /// <summary>Parses <c>dotnet --list-sdks</c> lines (<c>10.0.403 [C:\Program Files\dotnet\sdk]</c>).</summary>
    public static List<InstalledSdkInfo> ParseSdkList(string output, string source = "system")
    {
        var sdks = new List<InstalledSdkInfo>();

        foreach (var rawLine in SplitLines(output))
        {
            var match = SdkListLine().Match(rawLine.Trim());
            if (!match.Success)
            {
                continue;
            }

            sdks.Add(new InstalledSdkInfo
            {
                Version = match.Groups[1].Value,
                Path = match.Groups[2].Value,
                Source = source,
            });
        }

        return sdks;
    }

    /// <summary>Installed SDKs from the system host plus the extension's private install.</summary>
    public static List<InstalledSdkInfo> MergeInstalledSdks(
        IReadOnlyList<InstalledSdkInfo> systemSdks,
        IReadOnlyList<string> privateVersions)
    {
        var byVersion = new Dictionary<string, InstalledSdkInfo>(StringComparer.Ordinal);
        foreach (var sdk in systemSdks)
        {
            byVersion[sdk.Version] = sdk;
        }

        foreach (var version in privateVersions)
        {
            byVersion.TryAdd(version, new InstalledSdkInfo
            {
                Version = version,
                Path = "~/.dotnet/sdk",
                Source = "private",
            });
        }

        // Newest first: versions compare numerically, not as strings (10 > 9).
        return [.. byVersion.Values.OrderByDescending(
            sdk => sdk.Version,
            Comparer<string>.Create(CompareVersions))];
    }

    /// <summary>Reads one MSBuild property out of <c>dotnet msbuild -getProperty</c> JSON output.</summary>
    public static string? ParseMsBuildProperty(string output, string property)
    {
        var start = output.IndexOf('{');
        var end = output.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(output[start..(end + 1)]);
            if (!document.RootElement.TryGetProperty("Properties", out var properties)
                || !properties.TryGetProperty(property, out var value)
                || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = value.GetString()?.Trim();
            return string.IsNullOrEmpty(text) ? null : text;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Parses the two tables printed by <c>dotnet sdk check</c>.</summary>
    public static SdkCheckResult ParseSdkCheck(string output)
    {
        var sdks = new List<SdkCheckRow>();
        var runtimes = new List<RuntimeCheckRow>();
        var section = SdkCheckSection.None;

        foreach (var rawLine in SplitLines(output))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var nextSection = SectionOf(line);
            if (nextSection is not null)
            {
                section = nextSection.Value;
                continue;
            }

            if (IsIgnorableLine(line))
            {
                continue;
            }

            if (section == SdkCheckSection.Sdks)
            {
                AddSdkRow(sdks, line);
            }
            else if (section == SdkCheckSection.Runtimes)
            {
                AddRuntimeRow(runtimes, line);
            }
        }

        return new SdkCheckResult
        {
            Sdks = sdks,
            Runtimes = runtimes,
            Unavailable = sdks.Count == 0 && runtimes.Count == 0,
            Raw = output,
        };
    }

    /// <summary>Status row for a concrete SDK version (falls back to its feature band line).</summary>
    public static string? FindSdkStatus(SdkCheckResult result, string version)
    {
        ArgumentNullException.ThrowIfNull(result);

        var exact = result.Sdks.FirstOrDefault(row => row.Version == version);
        if (exact is not null)
        {
            return exact.Status;
        }

        var parts = version.Split('.');
        var band = parts.Length >= 2 ? $"{parts[0]}.{parts[1]}." : $"{version}.";
        return result.Sdks.FirstOrDefault(row => row.Version.StartsWith(band, StringComparison.Ordinal))?.Status;
    }

    private static string? DotnetPath(ToolchainProbeInput input) =>
        input.Command == "dotnet" ? null : input.Command;

    /// <summary>
    /// The two local-tool findings. The host reads the manifests and probes the machine; this
    /// method only decides what counts as a problem, so the evaluator keeps its no-I/O guarantee.
    /// </summary>
    private static LocalToolFindings EvaluateLocalTools(IReadOnlyList<LocalToolProbe> localTools)
    {
        var issues = new List<ToolchainIssueInfo>();
        var manifests = new List<string>();
        var notRestored = new List<string>();

        foreach (var manifest in localTools)
        {
            if (string.IsNullOrWhiteSpace(manifest.ManifestPath))
            {
                continue;
            }

            if (!manifests.Contains(manifest.ManifestPath, StringComparer.OrdinalIgnoreCase))
            {
                manifests.Add(manifest.ManifestPath);
            }

            if (manifest.Problems.Count > 0)
            {
                issues.Add(new ToolchainIssueInfo
                {
                    Kind = LocalToolManifestInvalidKind,
                    Summary =
                        $"{manifest.ManifestPath} is not a usable tool manifest: {manifest.Problems[0]}",
                    Hint =
                        "Fix the manifest and run `dotnet tool restore` in that folder: every local tool command there fails until it parses.",
                    Detail = string.Join("\n", manifest.Problems),
                });
            }

            var missing = new List<string>();
            foreach (var tool in manifest.Tools)
            {
                // Only a completed probe says anything: an unprobed tool is unknown, not missing.
                if (tool.Restored != false || string.IsNullOrWhiteSpace(tool.Id))
                {
                    continue;
                }

                missing.Add($"{tool.Id} ({tool.Version})");

                if (!notRestored.Contains(tool.Id, StringComparer.OrdinalIgnoreCase))
                {
                    notRestored.Add(tool.Id);
                }
            }

            if (missing.Count == 0)
            {
                continue;
            }

            issues.Add(new ToolchainIssueInfo
            {
                Kind = LocalToolNotRestoredKind,
                Summary =
                    $"{missing.Count} local tool(s) in {manifest.ManifestPath} are not restored on this machine: " +
                    $"{string.Join(", ", missing)}.",
                Hint =
                    "Run `dotnet tool restore` in that folder. This is a best-effort check of the global packages folder on this machine, not proof the tool runs on every platform.",
                Detail =
                    "`dotnet tool list --local` reads the manifest and does not prove the package was downloaded; " +
                    "the probe looks for the package version in the global packages folder.",
            });
        }

        return new LocalToolFindings(
            manifests.Count > 0 ? manifests : null,
            notRestored.Count > 0 ? notRestored : null,
            issues);
    }

    private const string LocalToolManifestInvalidKind = "LocalToolManifestInvalid";

    private const string LocalToolNotRestoredKind = "LocalToolNotRestored";

    private static string? ReadCommandVersion(CommandOutput result)
    {
        if (result.Code != 0)
        {
            return null;
        }

        var first = SplitLines(result.Stdout).FirstOrDefault()?.Trim();
        return string.IsNullOrEmpty(first) ? null : first;
    }

    private static string JoinOutput(string stderr, string stdout)
    {
        var parts = new[] { stderr, stdout }.Where(part => part.Length > 0);
        return string.Join("\n", parts);
    }

    private static ToolchainIssueInfo ToIssue(DotnetFailureInfo failure) =>
        new()
        {
            Kind = failure.Kind,
            Summary = failure.Summary,
            Hint = failure.Hint,
            Detail = failure.Detail,
        };

    private static bool? CheckPinMatch(
        ToolchainProbeInput input,
        string sdkVersion,
        List<ToolchainIssueInfo> issues)
    {
        if (input.PinnedSdkVersion is null)
        {
            return null;
        }

        var matches = SdkSatisfiesPin(
            sdkVersion,
            input.PinnedSdkVersion,
            ReadRollForward(input.GlobalJsonPath));
        if (matches)
        {
            return true;
        }

        issues.Add(new ToolchainIssueInfo
        {
            Kind = "SdkPinMismatch",
            Summary =
                $"dotnet selects SDK {sdkVersion}, but {input.GlobalJsonPath ?? "global.json"} pins {input.PinnedSdkVersion}.",
            Hint =
                "Pick an installed SDK in the selector (it updates global.json), install the pinned SDK, or relax `sdk.version` / `rollForward`.",
        });
        return false;
    }

    private static string? ReadRollForward(string? globalJsonPath)
    {
        if (globalJsonPath is null)
        {
            return null;
        }

        try
        {
            return GlobalJson.Parse(File.ReadAllText(globalJsonPath))?.RollForward;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static (bool Failed, string? BuildSdkVersion) EvaluateProject(
        ToolchainProbeInput input,
        string sdkVersion,
        List<ToolchainIssueInfo> issues)
    {
        if (input.ProjectPath is null || input.Evaluation is null)
        {
            return (false, null);
        }

        var evaluation = input.Evaluation;
        if (evaluation.Code != 0)
        {
            var failure = DotnetFailureClassifier.Classify(
                JoinOutput(evaluation.Stdout, evaluation.Stderr),
                new DotnetFailureContext(
                    ProjectPath: input.ProjectPath,
                    PinnedSdkVersion: input.PinnedSdkVersion,
                    GlobalJsonPath: input.GlobalJsonPath));
            issues.Add(ToIssue(failure));
            return (true, null);
        }

        var buildSdkVersion = ParseMsBuildProperty(evaluation.Stdout, "NETCoreSdkVersion");
        if (buildSdkVersion is null || buildSdkVersion == sdkVersion)
        {
            return (false, buildSdkVersion);
        }

        issues.Add(new ToolchainIssueInfo
        {
            Kind = "SdkSelectionMismatch",
            Summary =
                $"dotnet --version reports {sdkVersion}, but the build resolves SDK {buildSdkVersion}.",
            Hint =
                "The MSBuild value is authoritative. Check the selector and global.json; a nested global.json or MSBuild property can change the SDK per project.",
        });
        return (false, buildSdkVersion);
    }

    /// <summary>Left-over manifest bands, with the hint that names them on a workload conflict.</summary>
    private static List<OrphanedManifestBand> DetectBands(
        IReadOnlyList<InstalledSdkInfo> installedSdks,
        List<ToolchainIssueInfo> issues)
    {
        var systemSdk = installedSdks.FirstOrDefault(sdk => sdk.Source == "system");
        if (systemSdk is null)
        {
            return [];
        }

        var bands = DetectOrphanedManifestBands(
            Path.GetDirectoryName(systemSdk.Path) ?? systemSdk.Path,
            [.. installedSdks.Select(sdk => sdk.Version)]);

        var workloadConflict = issues.FirstOrDefault(issue => issue.Kind == "WorkloadManifestConflict");
        if (workloadConflict is not null && bands.Count > 0)
        {
            var index = issues.IndexOf(workloadConflict);
            issues[index] = workloadConflict with
            {
                Hint = workloadConflict.Hint + DescribeOrphanedBands(bands),
            };
        }

        return bands;
    }

    private static string DescribeOrphanedBands(IReadOnlyList<OrphanedManifestBand> orphans)
    {
        var list = string.Join(", ", orphans.Select(orphan => $"{orphan.Band} ({orphan.Path})"));
        return $" Left-over workload manifests exist for feature band(s) with no installed SDK: {list}."
            + " Neither `dotnet workload update` nor `repair` removes them — delete that folder with administrator rights, or reinstall the SDK that owns it.";
    }

    private static List<OrphanedManifestBand> DetectOrphanedManifestBands(
        string dotnetRoot,
        IReadOnlyList<string> installedVersions)
    {
        var manifestsRoot = Path.Combine(dotnetRoot, "sdk-manifests");
        var installedBands = new HashSet<string>(
            installedVersions.Select(GlobalJson.FeatureBand),
            StringComparer.Ordinal);
        var orphans = new List<OrphanedManifestBand>();

        if (!Directory.Exists(manifestsRoot))
        {
            return orphans;
        }

        foreach (var bandPath in Directory.EnumerateDirectories(manifestsRoot))
        {
            var band = Path.GetFileName(bandPath);
            // Only stable band folders count: prerelease bands are routinely installed by
            // Visual Studio and referenced by active workloads.
            if (!StableBand().IsMatch(band) || installedBands.Contains(band))
            {
                continue;
            }

            var manifests = Directory.Exists(bandPath)
                ? Directory.EnumerateDirectories(bandPath)
                    .Select(path => Path.GetFileName(path) ?? string.Empty)
                    .ToList()
                : [];
            orphans.Add(new OrphanedManifestBand(band, bandPath, manifests));
        }

        return [.. orphans.OrderByDescending(
            orphan => orphan.Band,
            Comparer<string>.Create(CompareVersions))];
    }

    private static int CompareVersions(string left, string right) =>
        NuGetVersion.TryParse(left, out var parsedLeft) && NuGetVersion.TryParse(right, out var parsedRight)
            ? parsedLeft.CompareTo(parsedRight)
            : string.CompareOrdinal(left, right);

    private static SdkCheckSection? SectionOf(string line)
    {
        if (DotnetSdksHeading().IsMatch(line))
        {
            return SdkCheckSection.Sdks;
        }

        if (DotnetRuntimesHeading().IsMatch(line))
        {
            return SdkCheckSection.Runtimes;
        }

        return null;
    }

    private static bool IsIgnorableLine(string line) =>
        SeparatorLine().IsMatch(line)
        || SdkColumns().IsMatch(line)
        || RuntimeColumns().IsMatch(line);

    private static void AddSdkRow(List<SdkCheckRow> sdks, string line)
    {
        var match = SdkRow().Match(line);
        if (match.Success)
        {
            sdks.Add(new SdkCheckRow(match.Groups[1].Value, match.Groups[2].Value));
        }
    }

    private static void AddRuntimeRow(List<RuntimeCheckRow> runtimes, string line)
    {
        var match = RuntimeRow().Match(line);
        if (match.Success)
        {
            runtimes.Add(new RuntimeCheckRow(
                match.Groups[1].Value,
                match.Groups[2].Value,
                match.Groups[3].Value));
        }
    }

    private static IEnumerable<string> SplitLines(string output) =>
        output.Split('\n').Select(line => line.TrimEnd('\r'));

    public sealed record SdkCheckRow(string Version, string Status);

    public sealed record RuntimeCheckRow(string Name, string Version, string Status);

    public sealed record SdkCheckResult
    {
        public required IReadOnlyList<SdkCheckRow> Sdks { get; init; }

        public required IReadOnlyList<RuntimeCheckRow> Runtimes { get; init; }

        public required bool Unavailable { get; init; }

        public required string Raw { get; init; }
    }

    public sealed record OrphanedManifestBand(string Band, string Path, IReadOnlyList<string> Manifests);

    /// <summary>The local-tool slices of a health result plus the issues they produced.</summary>
    private sealed record LocalToolFindings(
        IReadOnlyList<string>? Manifests,
        IReadOnlyList<string>? NotRestored,
        List<ToolchainIssueInfo> Issues);

    [GeneratedRegex(@"^(\S+)\s+\[(.+)\]\s*$", RegexOptions.CultureInvariant)]
    private static partial Regex SdkListLine();

    [GeneratedRegex(@"^-{4,}$", RegexOptions.CultureInvariant)]
    private static partial Regex SeparatorLine();

    [GeneratedRegex(@"^\.NET SDKs:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DotnetSdksHeading();

    [GeneratedRegex(@"^\.NET Runtimes:", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex DotnetRuntimesHeading();

    [GeneratedRegex(@"^Version\s+Status$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SdkColumns();

    [GeneratedRegex(@"^Name\s+Version\s+Status$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RuntimeColumns();

    [GeneratedRegex(@"^(\S+)\s{2,}(\S.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex SdkRow();

    [GeneratedRegex(@"^(\S+)\s+(\S+)\s{2,}(\S.*)$", RegexOptions.CultureInvariant)]
    private static partial Regex RuntimeRow();

    [GeneratedRegex(@"^\d+\.\d+\.\d+$", RegexOptions.CultureInvariant)]
    private static partial Regex StableBand();
}
