namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>A file that could not be read or parsed. Reported, never fatal.</summary>
public sealed record NuGetConfigFailure(string Path, string Message);
