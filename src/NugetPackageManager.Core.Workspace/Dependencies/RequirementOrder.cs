using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>Where a package belongs in the apply order.</summary>
public sealed record RequirementOrder
{
    /// <summary>0 = nothing it requires must move first; higher = apply later.</summary>
    [JsonPropertyName("Order")]
    public required int Order { get; init; }

    [JsonPropertyName("DependsOn")]
    public required IReadOnlyList<string> DependsOn { get; init; }
}
