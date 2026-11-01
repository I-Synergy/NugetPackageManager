using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>Result of analysing one project's restored graph.</summary>
public sealed record DependencyAnalysis
{
    [JsonPropertyName("Issues")]
    public required IReadOnlyList<DependencyIssue> Issues { get; init; }

    [JsonPropertyName("Skipped")]
    public required bool Skipped { get; init; }

    [JsonPropertyName("Reason")]
    public string? Reason { get; init; }
}
