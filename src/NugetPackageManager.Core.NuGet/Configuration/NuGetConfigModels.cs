namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>One <c>&lt;packageSources&gt;/&lt;add&gt;</c> entry as the file declares it.</summary>
public sealed record NuGetConfigSource(string Name, string Url);

/// <summary>Credentials attached to a source, after <c>_xHHHH_</c> name decoding.</summary>
public sealed record NuGetConfigCredential(string? Username, string? Password);

/// <summary>The result of parsing one <c>nuget.config</c> file.</summary>
public sealed record NuGetConfigFile(
    IReadOnlyList<NuGetConfigSource> Sources,
    IReadOnlyDictionary<string, NuGetConfigCredential> Credentials,
    IReadOnlyList<string> DisabledSources,
    bool Clear,
    IReadOnlyDictionary<string, IReadOnlyList<string>> Mappings,
    bool ClearMappings);

/// <summary>A config file in resolution order. <paramref name="IsWorkspace"/> gates environment expansion.</summary>
public sealed record NuGetConfigLocation(string Path, bool IsWorkspace);

/// <summary>A file that could not be read or parsed. Reported, never fatal.</summary>
public sealed record NuGetConfigFailure(string Path, string Message);

/// <summary>A source after merging: the file entry plus its credentials and mapping patterns.</summary>
public sealed record ResolvedNuGetSource(
    string Name,
    string Url,
    string? Username,
    string? Password,
    IReadOnlyList<string>? Patterns);

/// <summary>The merged view the host consumes.</summary>
public sealed record NuGetConfigResolution(
    IReadOnlyList<ResolvedNuGetSource> Sources,
    bool ClearFound,
    IReadOnlyList<NuGetConfigFailure> Failures);

/// <summary>
/// The host machine as discovery and expansion see it. Passed explicitly so the resolver is
/// testable without touching the real machine.
/// </summary>
public sealed record NuGetConfigEnvironment(
    string Platform,
    string HomeDirectory,
    Func<string, string?> GetVariable);
