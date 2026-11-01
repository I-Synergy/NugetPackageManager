namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// The effective package versions MSBuild produced for one project. Central versions come from
/// <c>PackageVersion</c> items (<c>Directory.Packages.props</c>), package references from the
/// project's own <c>PackageReference</c> items. All values are fully evaluated, so a
/// <c>$(Property)</c> reference is already replaced by its value.
/// </summary>
public sealed record CpmEvaluation
{
    public required IReadOnlyDictionary<string, string> CentralVersions { get; init; }

    public required IReadOnlyDictionary<string, string> PackageReferences { get; init; }
}
