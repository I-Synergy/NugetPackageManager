namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>A source after merging: the file entry plus its credentials and mapping patterns.</summary>
public sealed record ResolvedNuGetSource(
    string Name,
    string Url,
    string? Username,
    string? Password,
    IReadOnlyList<string>? Patterns);
