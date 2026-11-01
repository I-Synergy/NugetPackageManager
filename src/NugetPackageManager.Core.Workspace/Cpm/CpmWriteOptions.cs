namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// The optional property-write settings of <see cref="CpmWriter.UpdatePackageVersionAsync"/>.
///
/// Both default to <c>null</c>, which keeps every change on the literal <c>PackageVersion</c> path
/// exactly as if no property locator had been supplied.
/// </summary>
public sealed record CpmWriteOptions
{
    /// <summary>
    /// Directories a defining property file must live inside before it is edited. Empty or
    /// <c>null</c> keeps every change on the literal path.
    /// </summary>
    public IReadOnlyList<string>? WorkspaceRoots { get; init; }

    /// <summary>
    /// Locates a property definition through MSBuild. <c>null</c> keeps every change on the literal
    /// path.
    /// </summary>
    public ICpmPropertyLocator? PropertyLocator { get; init; }
}
