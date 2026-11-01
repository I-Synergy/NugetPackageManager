using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Diagnostics;

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
