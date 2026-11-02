using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// The frameworks one package version supports, grouped by product. An empty
/// <see cref="Groups"/> list is the truthful answer for a package with no framework assets.
/// </summary>
public sealed record PackageFrameworks(
    [property: JsonPropertyName("Groups")] IReadOnlyList<PackageFrameworkGroup> Groups);
