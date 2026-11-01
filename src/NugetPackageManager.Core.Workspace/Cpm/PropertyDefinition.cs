namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// One unconditional MSBuild property definition found in the file that really declares it.
///
/// <see cref="Value"/> is the raw text MSBuild and the XML both read; it may itself reference
/// other properties, in which case the writer replaces it with the concrete version.
/// </summary>
public sealed record PropertyDefinition(string FilePath, string PropertyName, string Value);
