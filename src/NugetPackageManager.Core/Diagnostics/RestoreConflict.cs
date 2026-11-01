
namespace NugetPackageManager.Core.Diagnostics;

/// <summary>
/// A recognized <c>NUxxxx</c> diagnostic. <see cref="PackageId"/> is empty when the
/// diagnostic does not name one.
/// </summary>
public sealed class RestoreConflict
{
    public required string Code { get; init; }

    public string PackageId { get; set; } = string.Empty;

    /// <summary>The version NuGet suggests referencing directly, when offered.</summary>
    public string? SuggestedVersion { get; set; }

    public string? ProjectName { get; set; }

    public required string Message { get; init; }

    public List<RestoreConstraint> Constraints { get; } = [];
}
