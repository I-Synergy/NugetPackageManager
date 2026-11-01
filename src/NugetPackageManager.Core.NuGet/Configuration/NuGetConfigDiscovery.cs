namespace NugetPackageManager.Core.NuGet.Configuration;

/// <summary>
/// Finds the config files NuGet would read, in the order it reads them: machine, user, then each
/// workspace folder. The file-system probe is injectable so the order is testable without writing
/// to the machine.
/// </summary>
public static class NuGetConfigDiscovery
{
    private static readonly string[] configFileNames = ["nuget.config", "NuGet.Config", "NuGet.config"];

    /// <summary>Every existing config file, lowest priority first.</summary>
    public static IReadOnlyList<NuGetConfigLocation> Discover(
        NuGetConfigEnvironment environment,
        IReadOnlyList<string> workspaceRoots,
        Func<string, bool>? fileExists = null)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(workspaceRoots);

        var exists = fileExists ?? File.Exists;
        var configs = new List<NuGetConfigLocation>();
        var isWindows = string.Equals(environment.Platform, "win32", StringComparison.Ordinal);

        // 1. Machine config (Windows only, lowest priority).
        if (isWindows)
        {
            var programFiles = FirstNonEmpty(
                environment.GetVariable("ProgramFiles(x86)"),
                environment.GetVariable("ProgramFiles"));

            if (programFiles is not null)
            {
                AddIfExists(configs, Path.Combine(programFiles, "NuGet", "Config", "Microsoft.VisualStudio.Offline.config"), exists);
            }
        }

        // 2. User config: ~/.config/NuGet on Unix, ~/.nuget everywhere, then %APPDATA% on Windows.
        if (!isWindows)
        {
            AddIfExists(configs, Path.Combine(environment.HomeDirectory, ".config", "NuGet", "NuGet.Config"), exists);
        }

        AddIfExists(configs, Path.Combine(environment.HomeDirectory, ".nuget", "NuGet", "NuGet.Config"), exists);

        if (isWindows)
        {
            var appData = environment.GetVariable("APPDATA");
            if (!string.IsNullOrEmpty(appData))
            {
                AddIfExists(configs, Path.Combine(appData, "NuGet", "NuGet.Config"), exists);
            }
        }

        // 3. Workspace folders (highest priority — processed last so `<clear/>` wins).
        foreach (var path in CollectWorkspaceConfigFiles(workspaceRoots, exists))
        {
            configs.Add(new NuGetConfigLocation(path, IsWorkspace: true));
        }

        return configs;
    }

    /// <summary>
    /// The config files a workspace owns: <c>.nuget/&lt;name&gt;</c> first, then the folder root.
    /// All workspace folders are included so a multi-root workspace reaches the folder whose
    /// config carries <c>&lt;clear/&gt;</c>.
    /// </summary>
    public static IReadOnlyList<string> CollectWorkspaceConfigFiles(
        IReadOnlyList<string> workspaceRoots,
        Func<string, bool>? fileExists = null)
    {
        ArgumentNullException.ThrowIfNull(workspaceRoots);

        var exists = fileExists ?? File.Exists;
        var configPaths = new List<string>();

        foreach (var workspaceRoot in workspaceRoots)
        {
            foreach (var filename in configFileNames)
            {
                var candidate = Path.Combine(workspaceRoot, ".nuget", filename);
                if (exists(candidate))
                {
                    configPaths.Add(candidate);
                    break;
                }
            }

            foreach (var filename in configFileNames)
            {
                var candidate = Path.Combine(workspaceRoot, filename);
                if (exists(candidate))
                {
                    configPaths.Add(candidate);
                    break;
                }
            }
        }

        return configPaths;
    }

    private static void AddIfExists(
        List<NuGetConfigLocation> configs,
        string path,
        Func<string, bool> exists)
    {
        if (exists(path))
        {
            configs.Add(new NuGetConfigLocation(path, IsWorkspace: false));
        }
    }

    private static string? FirstNonEmpty(string? first, string? second) =>
        !string.IsNullOrEmpty(first) ? first : !string.IsNullOrEmpty(second) ? second : null;
}
