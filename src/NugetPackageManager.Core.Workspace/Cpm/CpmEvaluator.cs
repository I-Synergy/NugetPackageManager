using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using NugetPackageManager.Core.Workspace.Infrastructure;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Default <see cref="ICpmEvaluator"/>: runs <c>dotnet msbuild -getItem</c> and reads the
/// fully-evaluated package versions from its JSON output.
///
/// The process spawn is expensive, so results are cached (bounded) and keyed on the project, the
/// governing <c>Directory.Packages.props</c> and <c>Directory.Build.props</c> timestamps; a stale
/// file invalidates the entry. Any failure (non-zero exit, timeout, unparseable output) yields
/// <c>null</c> so callers keep the raw XML values.
/// </summary>
/// <param name="gate">
/// The gate to wait on before spawning <c>dotnet msbuild</c>; <c>null</c> means
/// <see cref="MsBuildProcessGate.Shared"/>.
/// The caller keeps ownership, so this instance never disposes it.
/// </param>
public sealed class CpmEvaluator(MsBuildProcessGate? gate = null) : ICpmEvaluator, IDisposable
{
    // One entry per project (and per target framework, since the key carries it), so a bound of 500
    // made a 500-project repository evict its own cache mid-scan: the next pass re-ran every
    // `dotnet msbuild -getItem`. The bound only guards against unbounded growth; the "clear when
    // full" behaviour is kept because a large monorepo is the reason for a generous bound, not an
    // LRU rewrite.
    private const int MaxCacheEntries = 16384;
    private const string DotnetExecutableName = "dotnet";
    private static readonly TimeSpan evaluationTimeout = TimeSpan.FromSeconds(60);

    private readonly MsBuildProcessGate processGate = gate ?? MsBuildProcessGate.Shared;
    private readonly Dictionary<string, CacheEntry> cache = [];
    private readonly object cacheLock = new();

    private sealed record CacheEntry(string FileStamp, CpmEvaluation? Evaluation);

    /// <summary>
    /// Test seam: when set, it replaces the <c>dotnet msbuild -getItem</c> spawn, so the cache's
    /// eviction behaviour can be verified without starting a process. Never set in production code.
    /// </summary>
    internal Func<string, string?, CancellationToken, Task<CpmEvaluation?>>? EvaluationOverride { get; set; }

    public async Task<CpmEvaluation?> EvaluateAsync(
        string projectPath,
        string? targetFramework,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);

        var cacheKey = CacheKey(projectPath, targetFramework);
        var stamp = BuildStamp(projectPath);
        lock (cacheLock)
        {
            if (cache.TryGetValue(cacheKey, out var cached) && cached.FileStamp == stamp)
            {
                return cached.Evaluation;
            }
        }

        var evaluation = await RunAsync(projectPath, targetFramework, cancellationToken).ConfigureAwait(false);

        lock (cacheLock)
        {
            if (cache.Count >= MaxCacheEntries)
            {
                cache.Clear();
            }

            cache[cacheKey] = new CacheEntry(stamp, evaluation);
        }

        return evaluation;
    }

    /// <summary>
    /// Number of cached evaluations; exposed for tests that verify invalidation.
    /// </summary>
    internal int CachedEntryCount
    {
        get
        {
            lock (cacheLock)
            {
                return cache.Count;
            }
        }
    }

    /// <summary>
    /// Drops every cached evaluation. The stamp check only sees the project,
    /// <c>Directory.Packages.props</c> and <c>Directory.Build.props</c>, so a write to any other
    /// imported <c>.props</c> file leaves stale entries behind until this is called.
    /// </summary>
    public void ClearCache()
    {
        lock (cacheLock)
        {
            cache.Clear();
        }
    }

    private static string CacheKey(string projectPath, string? targetFramework) =>
        string.Concat(projectPath, "|", targetFramework ?? string.Empty);

    private async Task<CpmEvaluation?> RunAsync(
        string projectPath,
        string? targetFramework,
        CancellationToken cancellationToken)
    {
        if (EvaluationOverride is { } evaluationOverride)
        {
            return await evaluationOverride(projectPath, targetFramework, cancellationToken).ConfigureAwait(false);
        }

        // The shared gate bounds the total number of `dotnet` processes, across both evaluators.
        using var lease = await processGate.AcquireAsync(cancellationToken).ConfigureAwait(false);

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
        startInfo.ArgumentList.Add("-getItem:PackageVersion");
        startInfo.ArgumentList.Add("-getItem:PackageReference");
        startInfo.ArgumentList.Add("-getProperty:TargetFramework");
        startInfo.ArgumentList.Add("-nologo");
        if (!string.IsNullOrEmpty(targetFramework))
        {
            startInfo.ArgumentList.Add($"-p:TargetFramework={targetFramework}");
        }

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return null;
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(evaluationTimeout);

        string output;
        try
        {
            // Read stderr to completion so the child never blocks on a full pipe.
            var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);
            output = await process.StandardOutput.ReadToEndAsync(timeout.Token).ConfigureAwait(false);
            await errorTask.ConfigureAwait(false);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            return null;
        }

        if (process.ExitCode != 0)
        {
            return null;
        }

        return ParseEvaluation(output);
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process already exited between the check and the kill.
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The process could not be killed; nothing else to do.
        }
    }

    /// <summary>
    /// Reads the <c>-getItem</c> JSON. Returns null when the payload is not the expected object,
    /// cannot be parsed, or carries no <c>Items</c> map; otherwise every package version it lists
    /// (a missing item array is simply empty).
    /// </summary>
    internal static CpmEvaluation? ParseEvaluation(string json)
    {
        ArgumentNullException.ThrowIfNull(json);

        var trimmed = json.TrimStart();
        if (trimmed.Length == 0 || trimmed[0] != '{')
        {
            return null;
        }

        try
        {
            using var document = JsonDocument.Parse(trimmed);
            if (!document.RootElement.TryGetProperty("Items", out var items)
                || items.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            return new CpmEvaluation
            {
                CentralVersions = ReadItems(items, "PackageVersion"),
                PackageReferences = ReadItems(items, "PackageReference"),
            };
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static Dictionary<string, string> ReadItems(JsonElement items, string itemName)
    {
        var versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!items.TryGetProperty(itemName, out var array) || array.ValueKind != JsonValueKind.Array)
        {
            return versions;
        }

        foreach (var item in array.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object
                || !item.TryGetProperty("Identity", out var identity)
                || identity.ValueKind != JsonValueKind.String
                || !item.TryGetProperty("Version", out var version)
                || version.ValueKind != JsonValueKind.String)
            {
                continue;
            }

            var packageId = identity.GetString();
            var packageVersion = version.GetString();
            if (!string.IsNullOrEmpty(packageId) && !string.IsNullOrEmpty(packageVersion))
            {
                versions[packageId] = packageVersion;
            }
        }

        return versions;
    }

    /// <summary>
    /// Absolute path of the <c>dotnet</c> host to run, resolved the same way as
    /// <see cref="TargetFrameworks.TargetFrameworkResolver"/>: the sidecar's own image when it is
    /// the muxer, otherwise <c>DOTNET_HOST_PATH</c>, otherwise <c>dotnet</c> on PATH.
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

    private static string BuildStamp(string projectPath)
    {
        var parts = new List<string> { Stamp(projectPath) };

        var cpmFile = CpmPropsReader.FindCpmFile(projectPath);
        if (cpmFile is not null)
        {
            parts.Add(Stamp(cpmFile));
        }

        var directory = Path.GetDirectoryName(projectPath);
        if (directory is not null)
        {
            var buildProps = Path.Combine(directory, "Directory.Build.props");
            if (File.Exists(buildProps))
            {
                parts.Add(Stamp(buildProps));
            }
        }

        return string.Join('|', parts);
    }

    private static string Stamp(string path) =>
        File.Exists(path)
            ? File.GetLastWriteTimeUtc(path).ToString("O", CultureInfo.InvariantCulture)
            : "missing";

    /// <summary>
    /// Retained so existing callers can keep disposing the evaluator. The MSBuild gate is owned by
    /// the caller that injected it (or by the process, for <see cref="MsBuildProcessGate.Shared"/>),
    /// so there is nothing here to release.
    /// </summary>
    public void Dispose()
    {
        // Intentionally empty: the gate is shared, never owned by this instance.
    }
}
