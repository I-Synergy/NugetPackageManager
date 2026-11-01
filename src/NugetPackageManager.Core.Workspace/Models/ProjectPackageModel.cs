using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Models;

/// <summary>One <c>PackageReference</c> after CPM resolution.</summary>
public sealed record ProjectPackageModel
{
    [JsonPropertyName("Id")]
    public required string Id { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("IsPinned")]
    public required bool IsPinned { get; init; }

    /// <summary><c>project</c>, <c>central</c> or <c>override</c>.</summary>
    [JsonPropertyName("VersionSource")]
    public required string VersionSource { get; init; }

    [JsonPropertyName("CpmFramework")]
    public string? CpmFramework { get; init; }

    [JsonPropertyName("CpmResolutions")]
    public IReadOnlyList<CpmResolutionModel>? CpmResolutions { get; init; }
}
