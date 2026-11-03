namespace NugetPackageManager.Core.Toolchain;

/// <summary>
/// One tool a local manifest declares, plus what the host could establish about it. The
/// evaluator stays pure: the host probes the machine and hands the answers in.
/// </summary>
public sealed record LocalToolProbeTool
{
    /// <summary>The package id the manifest pins.</summary>
    public required string Id { get; init; }

    /// <summary>The version the manifest pins.</summary>
    public required string Version { get; init; }

    /// <summary>
    /// False when the host's best-effort restore probe did not find the package in the global
    /// packages folder; null when the probe did not run, so the evaluator says nothing.
    /// </summary>
    public bool? Restored { get; init; }
}

/// <summary>
/// A <c>.config/dotnet-tools.json</c> as the host read it. Supplied to
/// <see cref="ToolchainAnalysis.Evaluate"/> so the findings cost no I/O in the pure evaluator.
/// </summary>
public sealed record LocalToolProbe
{
    /// <summary>The absolute manifest path the findings name.</summary>
    public required string ManifestPath { get; init; }

    /// <summary>What stopped the manifest from being usable; empty when it parsed cleanly.</summary>
    public IReadOnlyList<string> Problems { get; init; } = [];

    /// <summary>The tools the manifest declares, with the host's restore probe.</summary>
    public IReadOnlyList<LocalToolProbeTool> Tools { get; init; } = [];
}
