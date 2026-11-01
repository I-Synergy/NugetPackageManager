using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

public sealed record PackageDependency
{
    [JsonPropertyName("package")]
    public required string Package { get; init; }

    [JsonPropertyName("versionRange")]
    public required string VersionRange { get; init; }
}
