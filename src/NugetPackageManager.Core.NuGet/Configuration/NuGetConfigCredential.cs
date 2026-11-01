namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>Credentials attached to a source, after <c>_xHHHH_</c> name decoding.</summary>
public sealed record NuGetConfigCredential(string? Username, string? Password);
