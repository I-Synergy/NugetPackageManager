using System.Text.Json.Serialization;

namespace NugetPackageManager.Core.Workspace.Dependencies;

public sealed record ClosureResult
{
    [JsonPropertyName("Conflicts")]
    public required IReadOnlyList<ClosureConflict> Conflicts { get; init; }

    /// <summary>Effective versions after applying every required version, keyed lower-case.</summary>
    [JsonPropertyName("Planned")]
    public required IReadOnlyDictionary<string, string> Planned { get; init; }
}
