namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Finds the file that defines an MSBuild property for a project, so a version update can rewrite
/// the definition instead of the <c>PackageVersion</c> line that references it.
/// </summary>
public interface ICpmPropertyLocator
{
    /// <summary>
    /// The unconditional definition of <paramref name="propertyName"/> MSBuild uses for
    /// <paramref name="projectPath"/>, or <c>null</c> when there is no such definition (conditional
    /// or target-scoped definitions are not safely editable and are reported as absent).
    /// </summary>
    Task<PropertyDefinition?> LocateAsync(
        string projectPath,
        string propertyName,
        CancellationToken cancellationToken);
}
