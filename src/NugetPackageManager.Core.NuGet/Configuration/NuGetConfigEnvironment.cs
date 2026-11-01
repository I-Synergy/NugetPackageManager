namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>
/// The host machine as discovery and expansion see it. Passed explicitly so the resolver is
/// testable without touching the real machine.
/// </summary>
public sealed record NuGetConfigEnvironment(
    string Platform,
    string HomeDirectory,
    Func<string, string?> GetVariable);
