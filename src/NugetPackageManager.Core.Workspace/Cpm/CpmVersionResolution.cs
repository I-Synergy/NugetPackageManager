
namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>One version line of a package for one target framework.</summary>
public sealed record CpmVersionResolution(
    string PackageId,
    string Tfm,
    string Version,
    string Condition,
    string ConditionLabel,
    bool Matched);
