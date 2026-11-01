using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;
using NugetPackageManager.Core.Workspace.Cpm;

namespace NugetPackageManager.Core;

/// <summary>Workspace-level methods the sidecar exposes over NDJSON.</summary>
public sealed class WorkspaceHandlers
{
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
            ["updateCpmVersions"] = HandleUpdateCpmVersionsAsync,
            ["removePackageVersion"] = HandleRemovePackageVersionAsync,
            ["updatePackageVersion"] = HandleUpdatePackageVersionAsync,
        };

    private async Task<object?> HandleUpdateCpmVersionsAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var propsFilePath = ReadRequiredString(parameters, "propsFilePath");
        var changes = ReadChanges(parameters);

        await CpmWriter.UpdateVersionsAsync(propsFilePath, changes, cancellationToken).ConfigureAwait(false);
        return new { applied = changes.Count };
    }

    private async Task<object?> HandleRemovePackageVersionAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        var propsFilePath = ReadRequiredString(parameters, "propsFilePath");
        var packageId = ReadRequiredString(parameters, "packageId");

        var removed = await CpmWriter
            .RemovePackageVersionAsync(propsFilePath, packageId, cancellationToken)
            .ConfigureAwait(false);

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

        await CpmWriter
            .UpdatePackageVersionAsync(projectPath, packageId, version, condition, scope, cancellationToken)
            .ConfigureAwait(false);

        return new { updated = true };
    }

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException("invalidParams", $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement parameters, string property) =>
        parameters.ValueKind == JsonValueKind.Object
        && parameters.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static CpmWriteScope? ReadScope(JsonElement parameters)
    {
        var scope = ReadOptionalString(parameters, "scope");
        if (string.IsNullOrEmpty(scope))
        {
            return null;
        }

        return Enum.TryParse<CpmWriteScope>(scope, ignoreCase: true, out var parsed)
            ? parsed
            : throw new RpcException("invalidParams", $"Unknown scope '{scope}'.");
    }

    private static List<CpmVersionChange> ReadChanges(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("changes", out var changes)
            || changes.ValueKind != JsonValueKind.Array)
        {
            throw new RpcException("invalidParams", "'changes' must be an array.");
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
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("projectPaths", out var paths)
            || paths.ValueKind != JsonValueKind.Array)
        {
            throw new RpcException("invalidParams", "'projectPaths' must be an array.");
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

        return await workspace
            .GetProjectsAsync(projectPaths, overrides, cancellationToken)
            .ConfigureAwait(false);
    }
}
