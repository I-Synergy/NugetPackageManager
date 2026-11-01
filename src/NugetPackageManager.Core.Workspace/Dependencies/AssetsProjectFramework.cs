using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

public sealed class AssetsProjectFramework
{
    [JsonPropertyName("dependencies")]
    public Dictionary<string, AssetsDirectDependency>? Dependencies { get; init; }
}
