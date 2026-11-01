using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>A version and the registration leaf URL that identifies it.</summary>
public sealed record PackageVersionRef
{
    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Id")]
    public required string Id { get; init; }
}
