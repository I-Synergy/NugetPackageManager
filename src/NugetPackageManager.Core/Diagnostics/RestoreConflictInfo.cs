using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Diagnostics;

/// <summary>Structured conflict as it crosses the RPC boundary (<c>RestoreConflictInfo</c>).</summary>
public sealed record RestoreConflictInfo
{
    [JsonPropertyName("Code")]
    public required string Code { get; init; }

    [JsonPropertyName("PackageId")]
    public required string PackageId { get; init; }

    [JsonPropertyName("SuggestedVersion")]
    public string? SuggestedVersion { get; init; }

    [JsonPropertyName("Message")]
    public required string Message { get; init; }

    [JsonPropertyName("Chains")]
    public required IReadOnlyList<string> Chains { get; init; }
}
