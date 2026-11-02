using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.NuGet.Models;

/// <summary>
/// One target framework the package supports (<c>PackageFrameworkItem</c>).
///
/// <see cref="IsComputed"/> is <c>false</c> for a framework the package itself declares an
/// asset for, and <c>true</c> when the framework is only supported through compatibility
/// (a <c>netstandard2.0</c> asset serving a <c>net8.0</c> project) — the same distinction
/// nuget.org draws between declared and computed frameworks.
/// </summary>
public sealed record PackageFrameworkItem(
    [property: JsonPropertyName("Name")] string Name,
    [property: JsonPropertyName("IsComputed")] bool IsComputed);
