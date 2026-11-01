
namespace NugetPackageManager.Core.Toolchain;

/// <summary>Captured output of one probe command.</summary>
public sealed record CommandOutput(int? Code, string Stdout, string Stderr, string? SpawnError = null);
