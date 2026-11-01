
namespace NugetPackageManager.Core.Diagnostics;

/// <summary>One dependency chain in a restore diagnostic.</summary>
public sealed record RestoreConstraint(string Chain, string Range);
