using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>Dependency groups for one package version (<c>PackageDetails</c>).</summary>
public sealed record PackageDetails
{
    [JsonPropertyName("dependencies")]
    public required PackageDependencyGroup Dependencies { get; init; }
}
