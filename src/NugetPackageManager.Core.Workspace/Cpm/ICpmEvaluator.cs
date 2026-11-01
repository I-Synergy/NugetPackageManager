namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Evaluates a project through MSBuild to obtain its effective package versions. A <c>null</c>
/// result means evaluation is unavailable or failed; callers then keep the raw XML values.
/// </summary>
public interface ICpmEvaluator
{
    Task<CpmEvaluation?> EvaluateAsync(
        string projectPath,
        string? targetFramework,
        CancellationToken cancellationToken);
}
