
namespace NugetPackageManager.Core.Workspace.Dependencies;

/// <summary>One declared dependency of a concrete package version.</summary>
public sealed record ClosureDependency(string Id, string Range);
