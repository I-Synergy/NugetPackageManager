using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>Outcome of pinning an SDK (<c>GlobalJsonUpdateResult</c>).</summary>
public sealed record GlobalJsonUpdateResult
{
    [JsonPropertyName("GlobalJsonPath")]
    public required string GlobalJsonPath { get; init; }

    /// <summary>True when the file did not exist and was created.</summary>
    [JsonPropertyName("Created")]
    public required bool Created { get; init; }

    /// <summary>False when the file already pinned this version with a coherent file.</summary>
    [JsonPropertyName("Changed")]
    public required bool Changed { get; init; }

    [JsonPropertyName("PreviousVersion")]
    public string? PreviousVersion { get; init; }

    /// <summary>The other properties that were adjusted.</summary>
    [JsonPropertyName("Notes")]
    public required IReadOnlyList<string> Notes { get; init; }
}
