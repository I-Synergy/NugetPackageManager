using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>
/// The direct references and framework list of a restored project, for the batch preflight.
/// Ids are lower-cased, as the host's previous reader did.
/// </summary>
public sealed record RestoredDirectDependencies
{
    [JsonPropertyName("DirectByTfm")]
    public required IReadOnlyDictionary<string, List<string>> DirectByTfm { get; init; }

    [JsonPropertyName("HasDirectSection")]
    public required bool HasDirectSection { get; init; }
}
