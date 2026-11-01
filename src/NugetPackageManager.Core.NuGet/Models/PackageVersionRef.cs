using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>One version the source offers. Addressed by id + version through NuGet.Protocol.</summary>
public sealed record PackageVersionRef(
    [property: JsonPropertyName("Version")] string Version);
