using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>A requirement the current graph does not satisfy.</summary>
public sealed record ClosureConflict
{
    /// <summary>The package that must be raised.</summary>
    [JsonPropertyName("PackageId")]
    public required string PackageId { get; init; }

    /// <summary>Version of the package that declares the requirement.</summary>
    [JsonPropertyName("RequiredByVersion")]
    public required string RequiredByVersion { get; init; }

    [JsonPropertyName("RequiredBy")]
    public required string RequiredBy { get; init; }

    [JsonPropertyName("Range")]
    public required string Range { get; init; }

    [JsonPropertyName("RequiredVersion")]
    public required string RequiredVersion { get; init; }

    [JsonPropertyName("Tfm")]
    public required string Tfm { get; init; }
}
