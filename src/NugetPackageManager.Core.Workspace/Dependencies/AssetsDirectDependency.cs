using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

public sealed class AssetsDirectDependency
{
    [JsonPropertyName("target")]
    public string? Target { get; init; }

    [JsonPropertyName("version")]
    public string? Version { get; init; }
}
