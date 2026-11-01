using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Workspace;

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
        };

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
