using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>The subset of <c>project.assets.json</c> the analysis needs.</summary>
public sealed class AssetsDocument
{
    [JsonPropertyName("targets")]
    public Dictionary<string, Dictionary<string, AssetsTargetEntry>>? Targets { get; init; }

    [JsonPropertyName("project")]
    public AssetsProject? Project { get; init; }
}
