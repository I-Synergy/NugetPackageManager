namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>The result of parsing one <c>nuget.config</c> file.</summary>
public sealed record NuGetConfigFile(
    IReadOnlyList<NuGetConfigSource> Sources,
    IReadOnlyDictionary<string, NuGetConfigCredential> Credentials,
    IReadOnlyList<string> DisabledSources,
    bool Clear,
    IReadOnlyDictionary<string, IReadOnlyList<string>> Mappings,
    bool ClearMappings);
