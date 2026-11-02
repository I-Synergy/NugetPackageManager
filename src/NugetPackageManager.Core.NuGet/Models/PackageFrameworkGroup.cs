using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>Supported frameworks for one product (<c>.NET</c>, <c>.NET Framework</c>, …).</summary>
public sealed record PackageFrameworkGroup(
    [property: JsonPropertyName("Product")] string Product,
    [property: JsonPropertyName("Frameworks")] IReadOnlyList<PackageFrameworkItem> Frameworks);
