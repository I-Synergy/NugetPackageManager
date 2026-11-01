using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Models;

/// <summary>A project as the webview consumes it (<c>Project</c> in <c>types.d.ts</c>).</summary>
public sealed record ProjectModel
{
    [JsonPropertyName("Name")]
    public required string Name { get; init; }

    [JsonPropertyName("Path")]
    public required string Path { get; init; }

    [JsonPropertyName("Packages")]
    public required IReadOnlyList<ProjectPackageModel> Packages { get; init; }

    [JsonPropertyName("CpmEnabled")]
    public required bool CpmEnabled { get; init; }

    [JsonPropertyName("TargetFrameworks")]
    public IReadOnlyList<string>? TargetFrameworks { get; init; }

    [JsonPropertyName("TfmSource")]
    public string? TfmSource { get; init; }
}

/// <summary>One <c>PackageReference</c> after CPM resolution.</summary>
public sealed record ProjectPackageModel
{
    [JsonPropertyName("Id")]
    public required string Id { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("IsPinned")]
    public required bool IsPinned { get; init; }

    /// <summary><c>project</c>, <c>central</c> or <c>override</c>.</summary>
    [JsonPropertyName("VersionSource")]
    public required string VersionSource { get; init; }

    [JsonPropertyName("CpmFramework")]
    public string? CpmFramework { get; init; }

    [JsonPropertyName("CpmResolutions")]
    public IReadOnlyList<CpmResolutionModel>? CpmResolutions { get; init; }
}

/// <summary>One framework line of a conditional <c>Directory.Packages.props</c> entry.</summary>
public sealed record CpmResolutionModel
{
    /// <summary>Empty for an unconditional version.</summary>
    [JsonPropertyName("Tfm")]
    public required string Tfm { get; init; }

    [JsonPropertyName("Version")]
    public required string Version { get; init; }

    [JsonPropertyName("Condition")]
    public required string Condition { get; init; }

    [JsonPropertyName("ConditionLabel")]
    public required string ConditionLabel { get; init; }

    [JsonPropertyName("Matched")]
    public required bool Matched { get; init; }
}
