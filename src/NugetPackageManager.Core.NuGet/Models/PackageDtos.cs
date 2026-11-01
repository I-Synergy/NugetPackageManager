using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// A package as the webview consumes it (<c>Package</c> in <c>types.d.ts</c>).
///
/// <see cref="Id"/> is the NuGet.org registration leaf URL, not a package id — that is what
/// the existing contract carries, and the webview uses it as an opaque version handle.
/// </summary>
public sealed record PackageDto
{
    [JsonPropertyName("Id")]
    public required string Id { get; init; }

    [JsonPropertyName("Name")]
    public required string Name { get; init; }

    [JsonPropertyName("Authors")]
    public required IReadOnlyList<string> Authors { get; init; }

    [JsonPropertyName("Description")]
    public required string Description { get; init; }

    [JsonPropertyName("IconUrl")]
    public required string IconUrl { get; init; }

    [JsonPropertyName("LicenseUrl")]
    public required string LicenseUrl { get; init; }

    [JsonPropertyName("ProjectUrl")]
    public required string ProjectUrl { get; init; }

    [JsonPropertyName("Registration")]
    public required string Registration { get; init; }

    [JsonPropertyName("TotalDownloads")]
    public required long TotalDownloads { get; init; }

    [JsonPropertyName("Verified")]
    public required bool Verified { get; init; }

    [JsonPropertyName("InstalledVersion")]
    public required string InstalledVersion { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Versions")]
    public required IReadOnlyList<PackageVersionRef> Versions { get; init; }

    [JsonPropertyName("Tags")]
    public required IReadOnlyList<string> Tags { get; init; }
}

/// <summary>A version and the registration leaf URL that identifies it.</summary>
public sealed record PackageVersionRef
{
    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Id")]
    public required string Id { get; init; }
}

/// <summary>Dependency groups for one package version (<c>PackageDetails</c>).</summary>
public sealed record PackageDetailsDto
{
    [JsonPropertyName("dependencies")]
    public required PackageDependencyGroupDto Dependencies { get; init; }
}

public sealed record PackageDependencyGroupDto
{
    [JsonPropertyName("frameworks")]
    public required Dictionary<string, List<PackageDependencyDto>> Frameworks { get; init; }
}

public sealed record PackageDependencyDto
{
    [JsonPropertyName("package")]
    public required string Package { get; init; }

    [JsonPropertyName("versionRange")]
    public required string VersionRange { get; init; }
}
