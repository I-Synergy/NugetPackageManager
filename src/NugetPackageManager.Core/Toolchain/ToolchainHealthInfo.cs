using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>Health of the .NET toolchain as the extension will use it (<c>ToolchainHealth</c>).</summary>
public sealed record ToolchainHealthInfo
{
    [JsonPropertyName("DotnetFound")]
    public required bool DotnetFound { get; init; }

    [JsonPropertyName("SdkVersion")]
    public string? SdkVersion { get; init; }

    [JsonPropertyName("BuildSdkVersion")]
    public string? BuildSdkVersion { get; init; }

    [JsonPropertyName("SdkStatus")]
    public string? SdkStatus { get; init; }

    [JsonPropertyName("SdkCheckUnavailable")]
    public bool? SdkCheckUnavailable { get; init; }

    [JsonPropertyName("OrphanedManifestBands")]
    public IReadOnlyList<string>? OrphanedManifestBands { get; init; }

    [JsonPropertyName("DotnetPath")]
    public string? DotnetPath { get; init; }

    [JsonPropertyName("GlobalJsonPath")]
    public string? GlobalJsonPath { get; init; }

    [JsonPropertyName("PinnedSdkVersion")]
    public string? PinnedSdkVersion { get; init; }

    [JsonPropertyName("SdkMatchesPin")]
    public bool? SdkMatchesPin { get; init; }

    [JsonPropertyName("ProjectEvaluationFailed")]
    public required bool ProjectEvaluationFailed { get; init; }

    [JsonPropertyName("CheckedAt")]
    public required string CheckedAt { get; init; }

    [JsonPropertyName("InstalledSdks")]
    public required IReadOnlyList<InstalledSdkInfo> InstalledSdks { get; init; }

    [JsonPropertyName("Issues")]
    public required IReadOnlyList<ToolchainIssueInfo> Issues { get; init; }
}
