
namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>One package the user is moving, with its target version.</summary>
public sealed record SelectedPackage(string Id, string Version);
