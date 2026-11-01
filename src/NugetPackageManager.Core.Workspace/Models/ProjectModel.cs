using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Models;

/// <summary>A project as the webview consumes it (<c>Project</c> in <c>types.d.ts</c>).</summary>
public sealed record ProjectModel
{
    [JsonPropertyName("Name")]
    public required string Name { get; init; }

    [JsonPropertyName("Path")]
    public required string Path { get; init; }

    [JsonPropertyName("Packages")]
    public required IReadOnlyList<ProjectPackageModel> Packages { get; init; }

    [JsonPropertyName("CpmEnabled")]
    public required bool CpmEnabled { get; init; }

    [JsonPropertyName("TargetFrameworks")]
    public IReadOnlyList<string>? TargetFrameworks { get; init; }

    [JsonPropertyName("TfmSource")]
    public string? TfmSource { get; init; }
}
