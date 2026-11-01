
namespace NugetPackageManager.Core.Toolchain;

/// <summary>Everything the host captured for one health check.</summary>
public sealed record ToolchainProbeInput
{
    public string? ProjectPath { get; init; }

    /// <summary>The <c>dotnet</c> host that ran the probe.</summary>
    public required string Command { get; init; }

    public string? GlobalJsonPath { get; init; }

    public string? PinnedSdkVersion { get; init; }

    public required CommandOutput Version { get; init; }

    public required CommandOutput SdkList { get; init; }

    /// <summary><c>dotnet msbuild -getProperty</c> output, when a project was evaluated.</summary>
    public CommandOutput? Evaluation { get; init; }

    /// <summary>Raw <c>dotnet sdk check</c> output; null when it could not run.</summary>
    public string? SdkCheckOutput { get; init; }

    public IReadOnlyList<string> PrivateSdkVersions { get; init; } = [];

    /// <summary>ISO timestamp supplied by the host so the result is deterministic.</summary>
    public required string CheckedAt { get; init; }
}
