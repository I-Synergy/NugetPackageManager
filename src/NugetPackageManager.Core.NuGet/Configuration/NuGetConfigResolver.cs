using System.Xml;

namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>
/// Merges the config files in discovery order into the source list the host consumes.
///
/// Semantics kept from the previous TypeScript implementation: later files win per source name,
/// a <c>&lt;clear/&gt;</c> resets sources and disabled entries but not credentials or mappings,
/// and only a <em>workspace</em> <c>&lt;clear/&gt;</c> sets <see cref="NuGetConfigResolution.ClearFound"/>
/// (that flag is what stops the host from adding VS Code settings sources).
/// </summary>
public static class NuGetConfigResolver
{
    /// <summary>Discovers, parses and merges every config file for the given workspace roots.</summary>
    public static NuGetConfigResolution Resolve(
        NuGetConfigEnvironment environment,
        IReadOnlyList<string> workspaceRoots,
        Func<string, string> readFile,
        Func<string, bool>? fileExists = null)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(workspaceRoots);
        ArgumentNullException.ThrowIfNull(readFile);

        var locations = NuGetConfigDiscovery.Discover(environment, workspaceRoots, fileExists);
        return Merge(environment, locations, readFile);
    }

    /// <summary>Merges an already-discovered list. Separated so tests pin the order directly.</summary>
    public static NuGetConfigResolution Merge(
        NuGetConfigEnvironment environment,
        IReadOnlyList<NuGetConfigLocation> locations,
        Func<string, string> readFile)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(locations);
        ArgumentNullException.ThrowIfNull(readFile);

        var sources = new Dictionary<string, NuGetConfigSource>(StringComparer.Ordinal);
        var order = new List<string>();
        var disabled = new HashSet<string>(StringComparer.Ordinal);
        var credentials = new Dictionary<string, NuGetConfigCredential>(StringComparer.Ordinal);
        var mappings = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        var failures = new List<NuGetConfigFailure>();
        var clearFound = false;

        foreach (var location in locations)
        {
            NuGetConfigFile parsed;

            try
            {
                // Environment expansion is allowed only above workspace level.
                parsed = NuGetConfigParser.Parse(readFile(location.Path), !location.IsWorkspace, environment.GetVariable);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or XmlException)
            {
                failures.Add(new NuGetConfigFailure(location.Path, exception.Message));
                continue;
            }

            if (parsed.Clear)
            {
                sources.Clear();
                order.Clear();
                disabled.Clear();

                if (location.IsWorkspace)
                {
                    clearFound = true;
                }
            }

            foreach (var source in parsed.Sources)
            {
                if (!sources.ContainsKey(source.Name))
                {
                    order.Add(source.Name);
                }

                // A later file replaces the entry but keeps the name's original position.
                sources[source.Name] = source;
            }

            foreach (var (name, credential) in parsed.Credentials)
            {
                credentials[name] = credential;
            }

            if (parsed.ClearMappings)
            {
                mappings.Clear();
            }

            foreach (var (key, patterns) in parsed.Mappings)
            {
                mappings[key] = patterns;
            }

            foreach (var name in parsed.DisabledSources)
            {
                disabled.Add(name);
            }
        }

        var resolved = new List<ResolvedNuGetSource>(order.Count);

        foreach (var name in order)
        {
            if (disabled.Contains(name))
            {
                continue;
            }

            var source = sources[name];
            credentials.TryGetValue(name, out var credential);
            mappings.TryGetValue(name, out var patterns);

            resolved.Add(new ResolvedNuGetSource(
                source.Name,
                source.Url,
                credential?.Username,
                credential?.Password,
                patterns));
        }

        return new NuGetConfigResolution(resolved, clearFound, failures);
    }
}
