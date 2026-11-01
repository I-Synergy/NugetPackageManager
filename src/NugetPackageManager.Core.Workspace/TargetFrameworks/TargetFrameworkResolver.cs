using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.TargetFrameworks;


/// <summary>
/// Resolves the target frameworks a project actually builds for.
///
/// Order matches the TypeScript resolver: a literal XML declaration first (cheap and
/// unambiguous), then the restore record in <c>obj/project.assets.json</c>, then
/// <c>dotnet msbuild -getProperty</c> (the only path that evaluates conditions), and finally a
/// literal XML parse when evaluation fails.
/// </summary>
public sealed partial class TargetFrameworkResolver : IDisposable
{
    private const int MaxCacheEntries = 500;
    private const string DotnetExecutableName = "dotnet";
    private static readonly TimeSpan evaluationTimeout = TimeSpan.FromSeconds(60);
    private static readonly string[] frameworkPropertyNames =
        [Constants.TargetFrameworks, Constants.TargetFramework];

    private readonly SemaphoreSlim evaluationSlots = new(16, 16);
    private readonly Dictionary<string, CacheEntry> cache = [];
    private readonly object cacheLock = new();

    private sealed record CacheEntry(string Key, TargetFrameworkInfo Info);

    public async Task<TargetFrameworkInfo> GetTargetFrameworksAsync(
        string projectPath,
        IReadOnlyList<string>? overrides,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        var extra = overrides ?? [];
        if (!File.Exists(projectPath))
        {
            return new TargetFrameworkInfo(Normalize(extra), TargetFrameworkSource.Override);
        }

        var key = BuildCacheKey(projectPath);
        lock (cacheLock)
        {
            if (cache.TryGetValue(projectPath, out var cached) && cached.Key == key)
            {
                return WithOverrides(cached.Info, extra);
            }
        }

        var info = await ResolveAsync(projectPath, cancellationToken).ConfigureAwait(false);
        info = WithOverrides(info, extra);

        lock (cacheLock)
        {
            if (cache.Count >= MaxCacheEntries)
            {
                cache.Clear();
            }

            cache[projectPath] = new CacheEntry(key, info);
        }

        return info;
    }

    private async Task<TargetFrameworkInfo> ResolveAsync(string projectPath, CancellationToken cancellationToken)
    {
        var literal = TryParseUnconditionalFrameworks(projectPath);
        if (literal is not null)
        {
            return literal;
        }

        var assets = TryResolveFromAssets(projectPath);
        if (assets is not null)
        {
            return assets;
        }

        try
        {
            var evaluated = await EvaluateWithMsBuildAsync(projectPath, cancellationToken).ConfigureAwait(false);
            if (evaluated.Count > 0)
            {
                return new TargetFrameworkInfo(evaluated, TargetFrameworkSource.MsBuild);
            }

            return ParseProjectFile(projectPath);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            var parsed = ParseProjectFile(projectPath);
            return parsed with { EvaluationFailed = true };
        }
    }

    /// <summary>
    /// Fast path: exactly one literal <c>TargetFramework(s)</c> element with no condition on it
    /// or any ancestor, and no property expression in the value.
    /// </summary>
    internal static TargetFrameworkInfo? TryParseUnconditionalFrameworks(string projectPath)
    {
        try
        {
            var document = XDocument.Load(projectPath);
            var elements = document.Descendants()
                .Where(element => element.Name.LocalName is Constants.TargetFramework or Constants.TargetFrameworks)
                .ToList();

            if (elements.Count != 1)
            {
                return null;
            }

            var element = elements[0];
            for (var ancestor = element; ancestor is not null; ancestor = ancestor.Parent)
            {
                if (ancestor.Attribute("Condition") is not null)
                {
                    return null;
                }
            }

            var raw = element.Value.Trim();
            if (raw.Length == 0 || PropertyExpressionRegex().IsMatch(raw))
            {
                return null;
            }

            var frameworks = Normalize(raw.Split(';'));
            return frameworks.Count > 0
                ? new TargetFrameworkInfo(frameworks, TargetFrameworkSource.Xml)
                : null;
        }
        catch (Exception exception) when (exception is IOException or System.Xml.XmlException)
        {
            return null;
        }
    }

    /// <summary>Frameworks recorded by the last restore, when the assets file is not stale.</summary>
    internal static TargetFrameworkInfo? TryResolveFromAssets(string projectPath)
    {
        var assetsPath = Path.Combine(Path.GetDirectoryName(projectPath) ?? ".", "obj", "project.assets.json");

        try
        {
            if (!File.Exists(assetsPath)
                || File.GetLastWriteTimeUtc(assetsPath) < File.GetLastWriteTimeUtc(projectPath))
            {
                return null;
            }

            using var stream = File.OpenRead(assetsPath);
            using var document = JsonDocument.Parse(stream);

            if (!document.RootElement.TryGetProperty("targets", out var targets)
                || targets.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var frameworks = Normalize(targets.EnumerateObject()
                .Select(target => target.Name.Split('/')[0]));

            return frameworks.Count > 0
                ? new TargetFrameworkInfo(frameworks, TargetFrameworkSource.Assets)
                : null;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Literal (non-evaluated) read of <c>TargetFramework(s)</c>, conditions ignored.</summary>
    internal static TargetFrameworkInfo ParseProjectFile(string projectPath)
    {
        try
        {
            var document = XDocument.Load(projectPath);

            var multi = document.Descendants()
                .FirstOrDefault(element => element.Name.LocalName == Constants.TargetFrameworks)?.Value.Trim() ?? string.Empty;
            if (multi.Length > 0 && !multi.Contains("$(", StringComparison.Ordinal))
            {
                var frameworks = Normalize(multi.Split(';'));
                if (frameworks.Count > 0)
                {
                    return new TargetFrameworkInfo(frameworks, TargetFrameworkSource.Xml);
                }
            }

            var single = document.Descendants()
                .FirstOrDefault(element => element.Name.LocalName == Constants.TargetFramework)?.Value.Trim() ?? string.Empty;
            if (single.Length > 0 && !single.Contains("$(", StringComparison.Ordinal))
            {
                return new TargetFrameworkInfo(Normalize([single]), TargetFrameworkSource.Xml);
            }
        }
        catch (Exception exception) when (exception is IOException or System.Xml.XmlException)
        {
            // Fall through to the empty answer below.
        }

        return new TargetFrameworkInfo([], TargetFrameworkSource.Xml);
    }

    /// <summary>
    /// Absolute path of the <c>dotnet</c> host to run. The sidecar is itself started through the
    /// muxer, so its own image is the same host the user's workspace is using; when that is not
    /// the case fall back to the SDK's <c>DOTNET_HOST_PATH</c>.
    /// </summary>
    private static string DotnetHost()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(processPath)
            && Path.GetFileNameWithoutExtension(processPath).Equals("dotnet", StringComparison.OrdinalIgnoreCase))
        {
            return processPath;
        }

        var hostPath = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        return string.IsNullOrEmpty(hostPath) ? DotnetExecutableName : hostPath;
    }

    /// <summary>Runs <c>dotnet msbuild -getProperty</c>; the only path that evaluates conditions.</summary>
    internal async Task<IReadOnlyList<string>> EvaluateWithMsBuildAsync(
        string projectPath,
        CancellationToken cancellationToken)
    {
        await evaluationSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = DotnetHost(),
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(projectPath) ?? Environment.CurrentDirectory,
            };

            startInfo.ArgumentList.Add("msbuild");
            startInfo.ArgumentList.Add(projectPath);
            startInfo.ArgumentList.Add("-getProperty:TargetFrameworks");
            startInfo.ArgumentList.Add("-getProperty:TargetFramework");
            startInfo.ArgumentList.Add("-nologo");

            using var process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("dotnet could not be started.");

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(evaluationTimeout);

            var output = await process.StandardOutput.ReadToEndAsync(timeout.Token).ConfigureAwait(false);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);

            return ParseFrameworks(output);
        }
        finally
        {
            evaluationSlots.Release();
        }
    }

    /// <summary>Reads the target frameworks from <c>-getProperty</c> output.</summary>
    internal static List<string> ParseFrameworks(string output)
    {
        ArgumentNullException.ThrowIfNull(output);

        // .NET 9+ answers `-getProperty` with JSON; older SDKs print `Property = value` lines.
        return Normalize(output.TrimStart().StartsWith('{')
            ? ReadFrameworksFromJson(output)
            : ReadFrameworksFromLines(output));
    }

    private static List<string> ReadFrameworksFromJson(string output)
    {
        var results = new List<string>();

        using var document = JsonDocument.Parse(output);
        if (!document.RootElement.TryGetProperty("Properties", out var properties)
            || properties.ValueKind != JsonValueKind.Object)
        {
            return results;
        }

        foreach (var name in frameworkPropertyNames)
        {
            if (properties.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String)
            {
                results.AddRange((value.GetString() ?? string.Empty).Split(';'));
            }
        }

        return results;
    }

    private static List<string> ReadFrameworksFromLines(string output)
    {
        var results = new List<string>();

        foreach (var line in output.Split('\n'))
        {
            var trimmed = line.Trim();
            var separator = trimmed.IndexOf('=', StringComparison.Ordinal);
            if (separator <= 0)
            {
                continue;
            }

            var name = trimmed[..separator].Trim();
            var value = trimmed[(separator + 1)..].Trim();
            if (value.Length == 0)
            {
                continue;
            }

            if (name.Equals(Constants.TargetFrameworks, StringComparison.OrdinalIgnoreCase)
                || name.Equals(Constants.TargetFramework, StringComparison.OrdinalIgnoreCase))
            {
                results.AddRange(value.Split(';'));
            }
        }

        return results;
    }

    private static TargetFrameworkInfo WithOverrides(TargetFrameworkInfo info, IReadOnlyList<string> overrides)
    {
        if (overrides.Count == 0)
        {
            return info;
        }

        var merged = Normalize(info.Frameworks.Concat(overrides));
        return info with { Frameworks = merged };
    }

    private static List<string> Normalize(IEnumerable<string> frameworks) =>
        [.. frameworks
            .Select(framework => framework.Trim())
            .Where(framework => framework.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)];

    public void Dispose() => evaluationSlots.Dispose();

    private static string BuildCacheKey(string projectPath)
    {
        var parts = new List<string>
        {
            File.GetLastWriteTimeUtc(projectPath).ToString("O", CultureInfo.InvariantCulture),
        };

        var directory = Path.GetDirectoryName(projectPath);
        foreach (var name in new[] { "Directory.Build.props", "Directory.Build.targets", "global.json" })
        {
            if (directory is null)
            {
                break;
            }

            var candidate = Path.Combine(directory, name);
            if (File.Exists(candidate))
            {
                parts.Add(File.GetLastWriteTimeUtc(candidate).ToString("O", CultureInfo.InvariantCulture));
            }
        }

        return string.Join('|', parts);
    }

    [GeneratedRegex(@"[$@%]\(", RegexOptions.CultureInvariant)]
    private static partial Regex PropertyExpressionRegex();
}
