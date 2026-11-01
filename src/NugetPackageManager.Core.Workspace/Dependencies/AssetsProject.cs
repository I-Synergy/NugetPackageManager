using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

public sealed class AssetsProject
{
    [JsonPropertyName("frameworks")]
    public Dictionary<string, AssetsProjectFramework>? Frameworks { get; init; }
}
