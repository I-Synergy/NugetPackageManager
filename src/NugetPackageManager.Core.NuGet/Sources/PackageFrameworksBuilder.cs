using NuGet.Frameworks;
using NugetPackageManager.Core.NuGet.Models;

namespace NugetPackageManager.Core.NuGet.Sources;

/// <summary>
/// Turns the target frameworks a package declares into the "Supported frameworks" list
/// nuget.org shows on the Frameworks tab.
///
/// The algorithm is the one nuget.org runs (NuGetGallery's <c>FrameworkCompatibilityService</c>):
/// a maintained list of known frameworks is crossed with itself using
/// <see cref="DefaultCompatibilityProvider"/>, so each known framework maps to the known
/// project frameworks that can consume it. A declared framework contributes every entry of its
/// row, and is itself reported as declared (<see cref="PackageFrameworkItem.IsComputed"/> is
/// <c>false</c>); everything else in the row is computed.
///
/// Kept as a pure static helper so the whole expansion is unit-testable without HTTP.
/// </summary>
public static class PackageFrameworksBuilder
{
    private static readonly string[] productOrder = [".NET", ".NET Core", ".NET Standard", ".NET Framework"];

    private static readonly string[] directFrameworkFolders =
        ["lib", "ref", "build", "buildtransitive"];

    private static readonly string[] contentFolders = ["content", "contentfiles"];

    private static readonly string[] runtimeAssetFolders = ["lib", "ref", "build"];

    private static readonly NuGetFramework[] knownFrameworks = BuildKnownFrameworks();

    private static readonly Dictionary<NuGetFramework, NuGetFramework[]> compatibilityMatrix =
        BuildCompatibilityMatrix();

    /// <summary>
    /// Builds the supported-framework list from what a package reader reports: the target
    /// frameworks of its typed item groups, and its file list (which also covers the folders
    /// that have no typed accessor, such as <c>buildTransitive</c> and <c>runtimes</c>).
    /// </summary>
    /// <param name="declaredFrameworks">
    /// Framework folder names already resolved by the reader (for example <c>netstandard2.0</c>).
    /// </param>
    /// <param name="filePaths">Package-relative paths; only asset folders are considered.</param>
    /// <param name="isToolPackage">
    /// A dotnet tool (or a package with a <c>tools</c> payload): only then do <c>tools/</c>
    /// paths describe supported frameworks rather than an opaque payload.
    /// </param>
    public static PackageFrameworks Build(
        IEnumerable<string>? declaredFrameworks,
        IEnumerable<string>? filePaths,
        bool isToolPackage)
    {
        var declared = new HashSet<NuGetFramework>(NuGetFrameworkFullComparer.Instance);

        foreach (var folder in declaredFrameworks ?? [])
        {
            if (TryParseFramework(folder) is { } framework)
            {
                declared.Add(framework);
            }
        }

        foreach (var path in filePaths ?? [])
        {
            if (FrameworkFromPath(path, isToolPackage) is { } framework)
            {
                declared.Add(framework);
            }
        }

        return Expand(declared);
    }

    /// <summary>Convenience overload for callers that only have a file list.</summary>
    public static PackageFrameworks FromFiles(IEnumerable<string> filePaths, bool isToolPackage) =>
        Build([], filePaths, isToolPackage);

    /// <summary>
    /// Expands already-parsed declared frameworks into the grouped, ordered result.
    /// Exposed for tests and for callers that own the framework parsing.
    /// </summary>
    public static PackageFrameworks Expand(IEnumerable<NuGetFramework> packageFrameworks)
    {
        ArgumentNullException.ThrowIfNull(packageFrameworks);

        var declared = new HashSet<NuGetFramework>(NuGetFrameworkFullComparer.Instance);
        foreach (var framework in packageFrameworks)
        {
            if (!framework.IsUnsupported && !framework.IsPCL)
            {
                declared.Add(framework);
            }
        }

        var supported = new Dictionary<NuGetFramework, bool>(NuGetFrameworkFullComparer.Instance);

        foreach (var packageFramework in declared)
        {
            // nuget.org matches a platform-versioned asset (net8.0-windows10.0.19041.0) by its
            // platform-agnostic form, then keeps the declared framework itself in the results.
            var hasPlatformVersion = !string.IsNullOrEmpty(packageFramework.Platform)
                && packageFramework.PlatformVersion != FrameworkConstants.EmptyVersion;

            var normalized = hasPlatformVersion
                ? new NuGetFramework(
                    packageFramework.Framework,
                    packageFramework.Version,
                    packageFramework.Platform,
                    FrameworkConstants.EmptyVersion)
                : packageFramework;

            if (!compatibilityMatrix.TryGetValue(normalized, out var compatible))
            {
                supported[packageFramework] = false;
                continue;
            }

            if (hasPlatformVersion)
            {
                // The row was computed for the platform-agnostic form; swap in the declared one.
                foreach (var framework in compatible)
                {
                    if (!framework.Equals(normalized))
                    {
                        Add(supported, framework, declared);
                    }
                }

                supported[packageFramework] = false;
            }
            else
            {
                foreach (var framework in compatible)
                {
                    Add(supported, framework, declared);
                }
            }
        }

        var groups = supported
            .GroupBy(pair => ProductName(pair.Key), StringComparer.Ordinal)
            .OrderBy(group => ProductOrder(group.Key))
            .ThenBy(group => group.Key, StringComparer.OrdinalIgnoreCase)
            .Select(group => new PackageFrameworkGroup(
                group.Key,
                [.. group
                    .OrderBy(pair => pair.Key, NuGetFrameworkSorter.Instance)
                    .Select(pair => new PackageFrameworkItem(pair.Key.GetShortFolderName(), pair.Value))]))
            .ToList();

        return new PackageFrameworks(groups);
    }

    private static void Add(
        Dictionary<NuGetFramework, bool> supported,
        NuGetFramework framework,
        HashSet<NuGetFramework> declared)
    {
        var isComputed = !declared.Contains(framework);
        if (supported.TryGetValue(framework, out var existing))
        {
            // A framework reached from several assets stays declared if any asset declares it.
            supported[framework] = existing && isComputed;
            return;
        }

        supported[framework] = isComputed;
    }

    private static int ProductOrder(string product)
    {
        var index = Array.IndexOf(productOrder, product);
        return index >= 0 ? index : productOrder.Length;
    }

    private static string ProductName(NuGetFramework framework)
    {
        var identifier = framework.Framework;

        if (IsIdentifier(identifier, ".NETCoreApp"))
        {
            return framework.Version.Major >= 5 ? ".NET" : ".NET Core";
        }

        if (IsIdentifier(identifier, ".NETStandard"))
        {
            return ".NET Standard";
        }

        if (IsIdentifier(identifier, ".NETFramework"))
        {
            return ".NET Framework";
        }

        if (IsIdentifier(identifier, ".NETMicroFramework"))
        {
            return ".NET Micro Framework";
        }

        if (IsIdentifier(identifier, "UAP"))
        {
            return "Universal Windows Platform";
        }

        if (IsIdentifier(identifier, "WindowsPhone") || IsIdentifier(identifier, "WindowsPhoneApp"))
        {
            return "Windows Phone";
        }

        if (IsIdentifier(identifier, "Windows") || IsIdentifier(identifier, ".NETCore"))
        {
            return "Windows Store";
        }

        if (identifier.StartsWith("Mono", StringComparison.OrdinalIgnoreCase)
            || identifier.StartsWith("Xamarin", StringComparison.OrdinalIgnoreCase))
        {
            return "Xamarin";
        }

        if (IsIdentifier(identifier, "Tizen"))
        {
            return "Tizen";
        }

        return identifier;
    }

    private static bool IsIdentifier(string identifier, string expected) =>
        string.Equals(identifier, expected, StringComparison.OrdinalIgnoreCase);

    /// <summary>Framework a package-relative path contributes, if any.</summary>
    private static NuGetFramework? FrameworkFromPath(string path, bool isToolPackage)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        var parts = path.Split(['/', '\\'], StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2)
        {
            return null;
        }

        var folder = parts[0];

        // tools/{tfm}/any/... describes a framework only for a tool package.
        if (string.Equals(folder, "tools", StringComparison.OrdinalIgnoreCase))
        {
            return isToolPackage && parts.Length > 2 ? TryParseFramework(parts[1]) : null;
        }

        // runtimes/{rid}/lib/{tfm}/... — the RID is not a framework; the asset folder is.
        if (string.Equals(folder, "runtimes", StringComparison.OrdinalIgnoreCase))
        {
            for (var index = 1; index < parts.Length - 2; index++)
            {
                if (runtimeAssetFolders.Contains(parts[index], StringComparer.OrdinalIgnoreCase)
                    && TryParseFramework(parts[index + 1]) is { } runtimeFramework)
                {
                    return runtimeFramework;
                }
            }

            return null;
        }

        // contentFiles/{language}/{tfm}/... and content/{tfm}/... put the language first.
        if (contentFolders.Contains(folder, StringComparer.OrdinalIgnoreCase))
        {
            for (var index = 1; index < parts.Length - 1; index++)
            {
                if (TryParseFramework(parts[index]) is { } contentFramework)
                {
                    return contentFramework;
                }
            }

            return null;
        }

        if (!directFrameworkFolders.Contains(folder, StringComparer.OrdinalIgnoreCase))
        {
            return null;
        }

        // lib/{tfm}/x.dll, ref/{tfm}/x.dll, build/{tfm}/x.props, build/{id}.props (no TFM).
        return parts.Length > 2 ? TryParseFramework(parts[1]) : null;
    }

    private static NuGetFramework? TryParseFramework(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder))
        {
            return null;
        }

        try
        {
            var framework = NuGetFramework.ParseFolder(folder);
            return framework.IsSpecificFramework ? framework : null;
        }
        catch (Exception exception) when (exception is ArgumentException or FormatException)
        {
            return null;
        }
    }

    private static Dictionary<NuGetFramework, NuGetFramework[]> BuildCompatibilityMatrix()
    {
        var matrix = new Dictionary<NuGetFramework, NuGetFramework[]>(
            NuGetFrameworkFullComparer.Instance);

        foreach (var packageFramework in knownFrameworks)
        {
            matrix[packageFramework] =
            [
                .. knownFrameworks.Where(projectFramework =>
                    DefaultCompatibilityProvider.Instance.IsCompatible(projectFramework, packageFramework)),
            ];
        }

        return matrix;
    }

    /// <summary>
    /// The frameworks nuget.org lists, ported from NuGetGallery's <c>SupportedFrameworks</c>.
    /// Platform variants carry an empty platform version on purpose: that is the key a
    /// platform-versioned declared framework normalises to.
    /// </summary>
    private static NuGetFramework[] BuildKnownFrameworks()
    {
        string[] folders =
        [
            // Xamarin
            "monoandroid", "monomac", "monotouch",
            "xamarinios10", "xamarinmac20", "xamarintvos10", "xamarinwatchos10",

            // .NET Framework
            "net35", "net40", "net403", "net45", "net451", "net452", "net46", "net461", "net462",
            "net463", "net47", "net471", "net472", "net48", "net481",

            // .NET Core (pre 5)
            "netcoreapp1.0", "netcoreapp1.1", "netcoreapp2.0", "netcoreapp2.1", "netcoreapp2.2",
            "netcoreapp3.0", "netcoreapp3.1",

            // Windows Store
            "netcore45", "netcore451", "win8", "win81",

            // .NET Standard
            "netstandard1.0", "netstandard1.1", "netstandard1.2", "netstandard1.3", "netstandard1.4",
            "netstandard1.5", "netstandard1.6", "netstandard2.0", "netstandard2.1",

            // Universal Windows Platform, Windows Phone, Silverlight
            "uap10.0", "wp7", "wp75", "wp8", "wp81", "wpa81", "sl4", "sl5",

            // Tizen
            "tizen30", "tizen40", "tizen60",

            // .NET Micro Framework
            "netmf",
        ];

        var frameworks = new List<NuGetFramework>();

        foreach (var folder in folders)
        {
            if (TryParseFramework(folder) is { } framework)
            {
                frameworks.Add(framework);
            }
        }

        // .NET 5 and later, with the platform variants Microsoft ships.
        for (var major = 5; major <= 11; major++)
        {
            var version = new Version(major, 0, 0, 0);
            frameworks.Add(new NuGetFramework(".NETCoreApp", version));

            foreach (var platform in PlannedPlatforms(major))
            {
                frameworks.Add(PlatformFramework(version, platform));
            }
        }

        return [.. frameworks];
    }

    private static string[] PlannedPlatforms(int major) => major switch
    {
        >= 8 => ["windows", "android", "ios", "maccatalyst", "macos", "tvos", "browser"],
        >= 6 => ["windows", "android", "ios", "maccatalyst", "macos", "tvos"],
        _ => ["windows"],
    };

    private static NuGetFramework PlatformFramework(Version version, string platform) =>
        new(".NETCoreApp", version, platform, FrameworkConstants.EmptyVersion);
}
