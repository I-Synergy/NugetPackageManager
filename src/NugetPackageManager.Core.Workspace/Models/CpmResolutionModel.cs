using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Models;

/// <summary>One framework line of a conditional <c>Directory.Packages.props</c> entry.</summary>
public sealed record CpmResolutionModel
{
    /// <summary>Empty for an unconditional version.</summary>
    [JsonPropertyName("Tfm")]
    public required string Tfm { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Condition")]
    public required string Condition { get; init; }

    [JsonPropertyName("ConditionLabel")]
    public required string ConditionLabel { get; init; }

    [JsonPropertyName("Matched")]
    public required bool Matched { get; init; }
}
