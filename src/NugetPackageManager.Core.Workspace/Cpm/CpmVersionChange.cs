
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>One version to write into a <c>Directory.Packages.props</c>.</summary>
public sealed record CpmVersionChange(
    string PackageId,
    string Version,
    string? Condition = null,
    CpmWriteScope? Scope = null)
{
    /// <summary>A condition means "that group", otherwise the first match.</summary>
    public CpmWriteScope EffectiveScope => Scope ?? (Condition is not null ? CpmWriteScope.Group : CpmWriteScope.First);
}
