
namespace NugetPackageManager.Core.Diagnostics;

/// <summary>Facts the host supplies about the invocation being classified.</summary>
public sealed record DotnetFailureContext(
    string? ProjectPath = null,
    string? PinnedSdkVersion = null,
    string? GlobalJsonPath = null,
    bool SpawnFailed = false);
