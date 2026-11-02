using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// One version the source offers. Addressed by id + version through NuGet.Protocol.
///
/// <see cref="Downloads"/> is the per-version download count when the feed publishes it
/// (the search resource does, registration does not); <c>null</c> means unknown, never zero.
/// </summary>
public sealed record PackageVersionRef(
    [property: JsonPropertyName("Version")] string Version,
    [property: JsonPropertyName("Downloads")] long? Downloads = null);
