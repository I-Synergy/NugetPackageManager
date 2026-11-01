namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>A config file in resolution order. <paramref name="IsWorkspace"/> gates environment expansion.</summary>
public sealed record NuGetConfigLocation(string Path, bool IsWorkspace);
