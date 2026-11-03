using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;
using NugetPackageManager.Core.Workspace.Cpm;
using NugetPackageManager.Core.Workspace.Infrastructure;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core;

/// <summary>Workspace-level methods the sidecar exposes over NDJSON.</summary>
public sealed class WorkspaceHandlers
{
    // One instance for the lifetime of the sidecar so its per-project cache survives across RPCs.
    // Passing it explicitly to every CpmWriter call that may edit a property is what keeps those
    // writes on the property path instead of the literal fallback.
    private static readonly CpmPropertyLocator propertyLocator = new();

    private const string PropsFilePathParameter = "propsFilePath";

    private readonly WorkspaceModelService workspace;

    public WorkspaceHandlers(WorkspaceModelService workspace)
    {
        ArgumentNullException.ThrowIfNull(workspace);
        this.workspace = workspace;
    }

    public Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["getProjects"] = HandleGetProjectsAsync,
            ["getCpmMap"] = HandleGetCpmMapAsync,
            ["updateCpmVersions"] = HandleUpdateCpmVersionsAsync,
            ["removePackageVersion"] = HandleRemovePackageVersionAsync,
            ["updatePackageVersion"] = HandleUpdatePackageVersionAsync,
            ["resolveCpmWriteTargets"] = HandleResolveCpmWriteTargetsAsync,
        };

    /// <summary>
    /// Methods that stream progress while they run. A name listed here wins over the plain
    /// handler of the same name, so the host can opt into progress by asking for it.
    /// </summary>
    public Dictionary<string, ContextRpcHandler> CreateContextHandlers() =>
        new(StringComparer.Ordinal)
        {
            ["getProjects"] = HandleGetProjectsWithProgressAsync,
        };

    private Task<object?> HandleGetCpmMapAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        var propsFilePath = ReadRequiredString(parameters, PropsFilePathParameter);
        if (!File.Exists(propsFilePath))
        {
            return Task.FromResult<object?>(null);
        }

        var map = CpmPropsReader.Parse(File.ReadAllText(propsFilePath));

        return Task.FromResult<object?>(new
        {
            // Keyed objects rather than arrays so the host can rebuild its Maps directly.
            unconditional = map.Unconditional,
            conditional = map.Conditional.Select(entry => new
            {
                condition = entry.Condition,
                framework = entry.Framework,
                versions = entry.Versions,
                order = entry.Order,
            }),
            hasConditionalGroups = map.HasConditionalGroups,
        });
    }

    private async Task<object?> HandleUpdateCpmVersionsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var propsFilePath = ReadRequiredString(parameters, PropsFilePathParameter);
        var changes = ReadChanges(parameters);
        var projectPaths = ReadStringArray(parameters, "projectPaths");
        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");

        var written = await CpmWriter
            .UpdateVersionsAsync(
                propsFilePath,
                changes,
                cancellationToken,
                projectPaths,
                workspaceRoots,
                propertyLocator)
            .ConfigureAwait(false);

        // A CPM write can edit a property in any imported .props file, so the evaluator cache
        // (keyed on project/Directory.*.props stamps) may still hold the pre-write version.
        workspace.InvalidateVersionCache();

        return new { applied = changes.Count, changedFiles = written };
    }

    private static async Task<object?> HandleResolveCpmWriteTargetsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var propsFilePath = ReadRequiredString(parameters, PropsFilePathParameter);
        var changes = ReadChanges(parameters);
        var projectPaths = ReadStringArray(parameters, "projectPaths");
        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");

        var files = await CpmWriter
            .ResolveWriteTargetsAsync(
                propsFilePath,
                changes,
                projectPaths,
                workspaceRoots,
                propertyLocator,
                cancellationToken)
            .ConfigureAwait(false);

        return new { files };
    }

    private async Task<object?> HandleRemovePackageVersionAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var propsFilePath = ReadRequiredString(parameters, PropsFilePathParameter);
        var packageId = ReadRequiredString(parameters, "packageId");

        var removed = await CpmWriter
            .RemovePackageVersionAsync(propsFilePath, packageId, cancellationToken)
            .ConfigureAwait(false);

        workspace.InvalidateVersionCache();

        return new { removed };
    }

    private async Task<object?> HandleUpdatePackageVersionAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var projectPath = ReadRequiredString(parameters, "projectPath");
        var packageId = ReadRequiredString(parameters, "packageId");
        var version = ReadRequiredString(parameters, "version");
        var condition = ReadOptionalString(parameters, "condition");
        var scope = ReadScope(parameters);
        var workspaceRoots = ReadStringArray(parameters, "workspaceRoots");

        await CpmWriter
            .UpdatePackageVersionAsync(
                projectPath,
                packageId,
                version,
                condition,
                scope,
                cancellationToken,
                new CpmWriteOptions { WorkspaceRoots = workspaceRoots, PropertyLocator = propertyLocator })
            .ConfigureAwait(false);

        workspace.InvalidateVersionCache();

        return new { updated = true };
    }

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException(Constants.InvalidParams, $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement parameters, string property) =>
        parameters.ValueKind == JsonValueKind.Object
        && parameters.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    /// <summary>A missing or non-array value reads as an empty list; blank entries are dropped.</summary>
    private static List<string> ReadStringArray(JsonElement parameters, string property)
    {
        var result = new List<string>();
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                var text = item.GetString();
                if (!string.IsNullOrWhiteSpace(text))
                {
                    result.Add(text);
                }
            }
        }

        return result;
    }

    private static CpmWriteScope? ReadScope(JsonElement parameters)
    {
        var scope = ReadOptionalString(parameters, "scope");
        if (string.IsNullOrEmpty(scope))
        {
            return null;
        }

        return Enum.TryParse<CpmWriteScope>(scope, ignoreCase: true, out var parsed)
            ? parsed
            : throw new RpcException(Constants.InvalidParams, $"Unknown scope '{scope}'.");
    }

    private static List<CpmVersionChange> ReadChanges(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("changes", out var changes)
            || changes.ValueKind != JsonValueKind.Array)
        {
            throw new RpcException(Constants.InvalidParams, "'changes' must be an array.");
        }

        var parsed = new List<CpmVersionChange>();
        foreach (var change in changes.EnumerateArray())
        {
            parsed.Add(new CpmVersionChange(
                ReadOptionalString(change, "packageId") ?? string.Empty,
                ReadOptionalString(change, "version") ?? string.Empty,
                ReadOptionalString(change, "condition"),
                ReadScope(change)));
        }

        return parsed;
    }

    private async Task<object?> HandleGetProjectsAsync(JsonElement parameters, CancellationToken cancellationToken)
    {
        var (projectPaths, overrides) = ReadGetProjectsParameters(parameters);

        var stopwatch = Stopwatch.StartNew();
        var evaluationsBefore = MsBuildProcessGate.Shared.TotalAcquisitions;
        var projectCount = 0;
        var completed = false;

        try
        {
            var projects = await workspace
                .GetProjectsAsync(projectPaths, overrides, cancellationToken)
                .ConfigureAwait(false);
            projectCount = projects.Count;
            completed = true;

            return projects;
        }
        finally
        {
            stopwatch.Stop();
            WriteGetProjectsDiagnostic(projectCount, stopwatch, evaluationsBefore, completed);
        }
    }

    /// <summary>
    /// The same scan as <see cref="HandleGetProjectsAsync" />, but every finished project is
    /// announced as a progress line so the host can show real progress instead of a spinner.
    /// The pending lines are awaited before the response so the last one is never lost.
    /// </summary>
    private async Task<object?> HandleGetProjectsWithProgressAsync(
        JsonElement parameters,
        RpcContext context,
        CancellationToken cancellationToken)
    {
        var (projectPaths, overrides) = ReadGetProjectsParameters(parameters);
        var reporter = new RpcProgressReporter(context);

        var stopwatch = Stopwatch.StartNew();
        var evaluationsBefore = MsBuildProcessGate.Shared.TotalAcquisitions;
        var projectCount = 0;
        var completed = false;

        try
        {
            try
            {
                var projects = await workspace
                    .GetProjectsAsync(projectPaths, overrides, cancellationToken, reporter)
                    .ConfigureAwait(false);
                projectCount = projects.Count;
                completed = true;

                return projects;
            }
            finally
            {
                await reporter.DrainAsync().ConfigureAwait(false);
            }
        }
        finally
        {
            stopwatch.Stop();
            WriteGetProjectsDiagnostic(projectCount, stopwatch, evaluationsBefore, completed);
        }
    }

    /// <summary>
    /// Writes the one perf line the extension log baselines a workspace parse from. stderr is the
    /// protocol's diagnostic channel, so this never interleaves with the NDJSON responses.
    /// </summary>
    private static void WriteGetProjectsDiagnostic(
        int projectCount,
        Stopwatch stopwatch,
        int evaluationsBefore,
        bool completed)
    {
        var evaluations = MsBuildProcessGate.Shared.TotalAcquisitions - evaluationsBefore;
        var peak = MsBuildProcessGate.Shared.PeakConcurrency;
        var suffix = completed ? string.Empty : " (not completed)";

        try
        {
            Console.Error.WriteLine(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"getProjects: {projectCount} project(s) in {stopwatch.ElapsedMilliseconds}ms ({evaluations} msbuild evaluation(s), {peak} in flight at peak){suffix}"));
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
            // stderr can be gone during shutdown; a lost diagnostic must never replace the real
            // result or exception of the scan it was measuring.
        }
    }

    private static (List<string> ProjectPaths, List<string> Overrides) ReadGetProjectsParameters(
        JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("projectPaths", out var paths)
            || paths.ValueKind != JsonValueKind.Array)
        {
            throw new RpcException(Constants.InvalidParams, "'projectPaths' must be an array.");
        }

        var projectPaths = paths.EnumerateArray()
            .Where(item => item.ValueKind == JsonValueKind.String)
            .Select(item => item.GetString() ?? string.Empty)
            .Where(path => path.Length > 0)
            .ToList();

        var overrides = new List<string>();
        if (parameters.TryGetProperty("extraTargetFrameworks", out var extra) && extra.ValueKind == JsonValueKind.Array)
        {
            overrides.AddRange(extra.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString() ?? string.Empty)
                .Where(value => value.Length > 0));
        }

        return (projectPaths, overrides);
    }

    /// <summary>
    /// Turns per-project parse reports into progress lines. <see cref="IProgress{T}.Report" />
    /// cannot be awaited, so the writes are tracked and flushed by <see cref="DrainAsync" />.
    /// </summary>
    private sealed class RpcProgressReporter(RpcContext context) : IProgress<ProjectParseProgress>
    {
        private readonly ConcurrentQueue<Task> pending = new();

        public void Report(ProjectParseProgress value)
        {
            ArgumentNullException.ThrowIfNull(value);

            var percent = value.Total > 0 ? (int)(100L * value.Completed / value.Total) : 0;
            pending.Enqueue(context.ReportProgressAsync(
                string.Create(
                    CultureInfo.InvariantCulture,
                    $"Parsing projects ({value.Completed}/{value.Total})…"),
                percent,
                value.Completed,
                value.Total));
        }

        /// <summary>Waits for every queued progress line; reporting failures are already swallowed.</summary>
        public async Task DrainAsync()
        {
            while (pending.TryDequeue(out var write))
            {
                await write.ConfigureAwait(false);
            }
        }
    }
}
