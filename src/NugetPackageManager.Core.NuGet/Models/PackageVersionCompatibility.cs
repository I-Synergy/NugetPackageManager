using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// Whether one package version can be consumed by a project's target frameworks, as far as the
/// registration metadata can tell.
///
/// <see cref="Known"/> is <c>false</c> when the version publishes no framework data or no project
/// framework could be parsed; <see cref="Compatible"/> is then <c>true</c> so an unprovable
/// candidate is never hidden (fail open).
/// </summary>
public sealed record PackageVersionCompatibility
{
    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Compatible")]
    public required bool Compatible { get; init; }

    [JsonPropertyName("Known")]
    public required bool Known { get; init; }
}
