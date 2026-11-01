
namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>One conditional <c>ItemGroup</c> of a <c>Directory.Packages.props</c>.</summary>
/// <remarks>
/// <see cref="Order"/> is mutable on purpose: the same condition can appear in several groups and
/// the last occurrence must win, so the entry is updated in place rather than replaced.
/// </remarks>
public sealed class CpmFrameworkEntry
{
    public required string Condition { get; init; }

    public required string Framework { get; init; }

    public required Dictionary<string, string> Versions { get; init; }

    public int Order { get; set; }
}
