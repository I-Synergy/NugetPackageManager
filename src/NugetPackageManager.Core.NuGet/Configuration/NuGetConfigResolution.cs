namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>The merged view the host consumes.</summary>
public sealed record NuGetConfigResolution(
    IReadOnlyList<ResolvedNuGetSource> Sources,
    bool ClearFound,
    IReadOnlyList<NuGetConfigFailure> Failures);
