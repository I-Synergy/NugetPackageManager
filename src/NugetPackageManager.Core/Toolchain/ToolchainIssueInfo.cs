using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>A toolchain problem with a hint the UI can show (<c>ToolchainIssue</c>).</summary>
public sealed record ToolchainIssueInfo
{
    [JsonPropertyName("Kind")]
    public required string Kind { get; init; }

    [JsonPropertyName("Summary")]
    public required string Summary { get; init; }

    [JsonPropertyName("Hint")]
    public required string Hint { get; init; }

    [JsonPropertyName("Detail")]
    public string? Detail { get; init; }
}
