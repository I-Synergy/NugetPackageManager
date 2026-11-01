using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

public sealed class AssetsTargetEntry
{
    [JsonPropertyName("type")]
    public string? Type { get; init; }

    [JsonPropertyName("dependencies")]
    public Dictionary<string, string>? Dependencies { get; init; }
}
