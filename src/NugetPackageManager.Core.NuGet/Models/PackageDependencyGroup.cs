using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

public sealed record PackageDependencyGroup
{
    [JsonPropertyName("frameworks")]
    public required Dictionary<string, List<PackageDependency>> Frameworks { get; init; }
}
