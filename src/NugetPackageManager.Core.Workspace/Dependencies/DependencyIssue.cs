using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>One row of the dependency-issue report (<c>DependencyIssue</c> in the host).</summary>
public sealed record DependencyIssue
{
    [JsonPropertyName("ProjectPath")]
    public required string ProjectPath { get; init; }

    [JsonPropertyName("Tfm")]
    public required string Tfm { get; init; }

    [JsonPropertyName("PackageId")]
    public required string PackageId { get; init; }

    [JsonPropertyName("DirectVersion")]
    public required string DirectVersion { get; init; }

    [JsonPropertyName("ResolvedVersion")]
    public required string ResolvedVersion { get; init; }

    /// <summary><c>Redundant</c> or <c>Pinned</c>.</summary>
    [JsonPropertyName("Kind")]
    public required string Kind { get; init; }

    [JsonPropertyName("Chain")]
    public required string Chain { get; init; }
}
