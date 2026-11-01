
namespace NugetPackageManager.Core.Workspace.TargetFrameworks;

/// <summary>The frameworks one project builds for, and how they were found.</summary>
public sealed record TargetFrameworkInfo(
    IReadOnlyList<string> Frameworks,
    TargetFrameworkSource Source,
    bool EvaluationFailed = false);
