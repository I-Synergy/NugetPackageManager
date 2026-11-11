using System.Globalization;
using System.Xml.Linq;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Resolves the <c>$(Property)</c> versions of a <c>Directory.Packages.props</c> from the property
/// definitions that live in the props file and in the files it imports, so a workspace scan does
/// not have to pay one <c>dotnet msbuild</c> evaluation per project to read a literal version.
///
/// The resolver is deliberately conservative — a wrong version is worse than a slow one. A version
/// is replaced only when the whole attribute value is a single <c>$(Name)</c> and <c>Name</c> has
/// exactly one distinct literal definition across the whole import chain. Concatenations, MSBuild
/// functions, undefined names, twice-defined names with different values and imports that cannot be
/// followed all leave that single entry exactly as written, so the caller still has the full,
/// correct map and can ask MSBuild only about the packages that actually need it.
/// </summary>
public sealed class CpmPropertyResolver : IDisposable
{
    // One entry per props file, so a bound of 64 made a large monorepo evict its own cache
    // mid-scan and re-read every props/import chain on the next pass. The bound only guards
    // against unbounded growth; "clear when full" is kept because a large monorepo is the reason
    // for a generous bound, not an LRU rewrite.
    private const int MaxCacheEntries = 512;
    private const int MaxImportDepth = 8;
    private const int MaxChainFiles = 128;
    private const string PropertyReference = "$(";

    private readonly Dictionary<string, CacheEntry> cache = [];
    private readonly System.Threading.Lock cacheLock = new();
    private int chainReads;

    /// <summary>
    /// Number of times the props/import chain was actually read from disk; exposed so tests can
    /// tell a cache hit from a re-parse.
    /// </summary>
    internal int ChainReads => Volatile.Read(ref chainReads);

    /// <summary>
    /// Returns <paramref name="map"/> with every <c>$(Property)</c> version it can be sure of
    /// replaced by its literal value. Entries it cannot resolve are left exactly as written, so the
    /// answer is always a usable map; <c>null</c> is reserved for a props file that cannot be read
    /// or parsed at all, where not even the caller's own copy is trustworthy.
    ///
    /// The map's structure is preserved: <c>Unconditional</c>, <c>Conditional</c> (with each entry's
    /// condition, framework label and order), <c>HasConditionalGroups</c> and the iteration order of
    /// the version dictionaries are all kept. A map without property references is returned as-is.
    /// </summary>
    /// <param name="propsFilePath">The <c>Directory.Packages.props</c> the map was parsed from.</param>
    /// <param name="map">The parsed map whose versions may reference properties.</param>
    public CpmPackageMap? TryResolve(string propsFilePath, CpmPackageMap map)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(propsFilePath);
        ArgumentNullException.ThrowIfNull(map);

        if (!HasPropertyReferences(map))
        {
            return map;
        }

        var table = LoadTable(propsFilePath);
        if (table is null)
        {
            // The props file itself is missing or unreadable: nothing about it is knowable.
            return null;
        }

        var unconditional = Substitute(map.Unconditional, table);
        var conditional = new List<CpmFrameworkEntry>(map.Conditional.Count);
        foreach (var entry in map.Conditional)
        {
            conditional.Add(new CpmFrameworkEntry
            {
                Condition = entry.Condition,
                Framework = entry.Framework,
                Versions = Substitute(entry.Versions, table),
                Order = entry.Order,
            });
        }

        return new CpmPackageMap(unconditional, conditional, map.HasConditionalGroups);
    }

    /// <summary>
    /// Drops the cached property tables. The stamp only covers the props file and the files it
    /// imports, so a write to any file outside that chain needs this explicit nudge.
    /// </summary>
    public void ClearCache()
    {
        lock (cacheLock)
        {
            cache.Clear();
        }
    }

    /// <summary>Releases the cached property tables; nothing unmanaged is held.</summary>
    public void Dispose() => ClearCache();

    private static bool HasPropertyReferences(CpmPackageMap map) =>
        map.Unconditional.Values.Any(IsPropertyVersion)
        || map.Conditional.Any(entry => entry.Versions.Values.Any(IsPropertyVersion));

    private static bool IsPropertyVersion(string version) =>
        version.Contains(PropertyReference, StringComparison.Ordinal);

    /// <summary>
    /// Replaces every property-based version it can; an entry it cannot be sure of is copied
    /// through exactly as written so only that package still needs an MSBuild evaluation.
    /// </summary>
    private static Dictionary<string, string> Substitute(
        Dictionary<string, string> versions,
        PropertyTable table)
    {
        var substituted = new Dictionary<string, string>(versions.Count, StringComparer.Ordinal);

        foreach (var (packageId, version) in versions)
        {
            substituted[packageId] = Substitute(version, table);
        }

        return substituted;
    }

    /// <summary>
    /// One version value: the literal definition when it is exactly one known property, otherwise
    /// the original text — concatenations, functions, undefined names and ambiguous definitions
    /// all need the MSBuild engine and are therefore left untouched.
    /// </summary>
    private static string Substitute(string version, PropertyTable table) =>
        IsPropertyVersion(version)
        && TryReadSingleReference(version, out var name)
        && table.Literals.TryGetValue(name.ToUpperInvariant(), out var literal)
            ? literal
            : version;

    /// <summary>
    /// True when <paramref name="value"/> is exactly one <c>$(Name)</c> reference (surrounding
    /// whitespace aside) and <paramref name="name"/> is a plain property name.
    /// </summary>
    private static bool TryReadSingleReference(string value, out string name)
    {
        name = string.Empty;

        var trimmed = value.Trim();
        if (trimmed.Length < 4
            || !trimmed.StartsWith(PropertyReference, StringComparison.Ordinal)
            || trimmed[^1] != ')')
        {
            return false;
        }

        var inner = trimmed[2..^1];
        if (inner.Length == 0)
        {
            return false;
        }

        // `$([System.String]::Copy(...))` fails here on the '[' and the ':'.
        if (inner.Any(character => !char.IsLetterOrDigit(character) && character is not ('_' or '.' or '-')))
        {
            return false;
        }

        name = inner;
        return true;
    }

    /// <summary>
    /// The cached property table of one props file, or <c>null</c> when the props file itself
    /// cannot be read or parsed. A file whose imports cannot be followed is cached with an empty
    /// table instead: nothing resolves, which is always safe, and the caller simply keeps the
    /// MSBuild path for the packages it cares about.
    /// </summary>
    private PropertyTable? LoadTable(string propsFilePath)
    {
        var key = Path.GetFullPath(propsFilePath);

        lock (cacheLock)
        {
            if (cache.TryGetValue(key, out var cached) && cached.Stamp == BuildStamp(cached.Files))
            {
                return cached.Table;
            }
        }

        var chain = LoadChain(key);
        if (!chain.RootReadable)
        {
            lock (cacheLock)
            {
                cache.Remove(key);
            }

            return null;
        }

        var stamp = BuildStamp([.. chain.Files.Select(file => file.Path)]);
        var table = chain.Complete ? BuildTable(chain.Files) : new PropertyTable();

        lock (cacheLock)
        {
            if (cache.TryGetValue(key, out var cached) && cached.Stamp == stamp)
            {
                // Another thread finished the same work while this one was reading the files.
                return cached.Table;
            }

            if (cache.Count >= MaxCacheEntries)
            {
                cache.Clear();
            }

            cache[key] = new CacheEntry([.. chain.Files.Select(file => file.Path)], stamp, table);
        }

        return table;
    }

    /// <summary>
    /// Reads the props file and, breadth-first, every file it imports. <c>Complete</c> is false when
    /// a file is missing or unreadable, an import path needs evaluation the resolver cannot do, the
    /// chain is deeper than <see cref="MaxImportDepth"/> or it grows past
    /// <see cref="MaxChainFiles"/>; <c>RootReadable</c> is false only when the props file itself
    /// could not be loaded.
    /// </summary>
    private ChainLoad LoadChain(string rootPath)
    {
        Interlocked.Increment(ref chainReads);

        var files = new List<ImportedFile>();
        var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var pending = new Queue<(string Path, int Depth)>();
        pending.Enqueue((rootPath, 0));

        while (pending.Count > 0)
        {
            var (current, depth) = pending.Dequeue();
            if (!visited.Add(current))
            {
                continue;
            }

            if (visited.Count > MaxChainFiles)
            {
                return Incomplete(files);
            }

            var document = TryLoad(current);
            if (document is null)
            {
                return Incomplete(files);
            }

            files.Add(new ImportedFile(current, document));

            var imports = ImportedPaths(document, current);
            if (imports is null)
            {
                return Incomplete(files);
            }

            foreach (var import in imports)
            {
                if (depth + 1 > MaxImportDepth)
                {
                    return Incomplete(files);
                }

                pending.Enqueue((import, depth + 1));
            }
        }

        return new ChainLoad(files, Complete: true, RootReadable: true);
    }

    /// <summary>
    /// A chain that could not be followed. The root is always the first file read, so a non-empty
    /// list means the props file itself loaded.
    /// </summary>
    private static ChainLoad Incomplete(List<ImportedFile> files) =>
        new(files, Complete: false, RootReadable: files.Count > 0);

    /// <summary>
    /// Absolute paths of the <c>&lt;Import Project="…"&gt;</c> targets of one file, or null when an
    /// import path stays unresolved after the identity properties are substituted.
    ///
    /// Import conditions are ignored on purpose: a conditional import can only add definitions, and
    /// an added definition makes a property ambiguous rather than silently wrong.
    /// </summary>
    private static List<string>? ImportedPaths(XDocument document, string currentFile)
    {
        var directory = Path.GetDirectoryName(currentFile) ?? ".";
        var imports = new List<string>();

        foreach (var element in document.Descendants().Where(candidate => candidate.Name.LocalName == "Import"))
        {
            var project = element.Attribute("Project")?.Value;
            if (string.IsNullOrWhiteSpace(project))
            {
                // `<Import Sdk="…" />` carries no path to follow; it cannot define a version
                // property of the package map either.
                continue;
            }

            var expanded = ExpandIdentityProperties(project.Trim(), currentFile, directory);
            if (expanded.Contains(PropertyReference, StringComparison.Ordinal)
                || expanded.IndexOfAny(['*', '?']) >= 0)
            {
                return null;
            }

            var native = expanded
                .Replace('\\', Path.DirectorySeparatorChar)
                .Replace('/', Path.DirectorySeparatorChar);

            imports.Add(Path.GetFullPath(Path.Combine(directory, native)));
        }

        return imports;
    }

    /// <summary>Substitutes the three import-path properties that need no evaluation.</summary>
    private static string ExpandIdentityProperties(string path, string currentFile, string directory) =>
        path
            .Replace("$(MSBuildThisFileFullPath)", currentFile, StringComparison.OrdinalIgnoreCase)
            .Replace("$(MSBuildThisFileDirectory)", directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            .Replace("$(MSBuildThisFile)", Path.GetFileName(currentFile), StringComparison.OrdinalIgnoreCase);

    private static XDocument? TryLoad(string path)
    {
        try
        {
            return File.Exists(path) ? XDocument.Load(path) : null;
        }
        catch (Exception exception) when (exception is IOException or System.Xml.XmlException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static PropertyTable BuildTable(List<ImportedFile> files)
    {
        var table = new PropertyTable();

        foreach (var file in files)
        {
            foreach (var group in file.Document.Descendants().Where(element => element.Name.LocalName == "PropertyGroup"))
            {
                foreach (var property in group.Elements())
                {
                    Record(table, property.Name.LocalName.ToUpperInvariant(), property);
                }
            }
        }

        return table;
    }

    /// <summary>
    /// Keeps one literal value per name; a name defined twice with different values, defined with a
    /// non-literal value, or defined empty becomes permanently unresolvable.
    /// </summary>
    private static void Record(PropertyTable table, string name, XElement property)
    {
        if (table.Ambiguous.Contains(name))
        {
            return;
        }

        if (property.HasElements || !IsLiteral(property.Value))
        {
            MarkAmbiguous(table, name);
            return;
        }

        var value = property.Value.Trim();
        if (value.Length == 0)
        {
            MarkAmbiguous(table, name);
            return;
        }

        if (table.Literals.TryGetValue(name, out var existing))
        {
            if (!string.Equals(existing, value, StringComparison.Ordinal))
            {
                MarkAmbiguous(table, name);
            }

            return;
        }

        table.Literals[name] = value;
    }

    private static void MarkAmbiguous(PropertyTable table, string name)
    {
        table.Literals.Remove(name);
        table.Ambiguous.Add(name);
    }

    /// <summary>True for a value with no property, item or metadata expression in it.</summary>
    private static bool IsLiteral(string value) =>
        !value.Contains(PropertyReference, StringComparison.Ordinal)
        && !value.Contains("@(", StringComparison.Ordinal)
        && !value.Contains("%(", StringComparison.Ordinal);

    /// <summary>Length and last-write stamp of every file in the chain, in chain order.</summary>
    private static string BuildStamp(List<string> files)
    {
        var parts = new List<string>(files.Count);
        foreach (var file in files)
        {
            var info = new FileInfo(file);
            parts.Add(info.Exists
                ? string.Concat(
                    info.FullName,
                    "#",
                    info.Length.ToString(CultureInfo.InvariantCulture),
                    "@",
                    info.LastWriteTimeUtc.ToString("O", CultureInfo.InvariantCulture))
                : string.Concat(file, "#missing"));
        }

        return string.Join('|', parts);
    }

    private sealed record ImportedFile(string Path, XDocument Document);

    /// <summary>
    /// One attempt at reading a props/import chain: the files that were read, whether the whole
    /// chain could be followed, and whether the root props file itself loaded.
    /// </summary>
    private sealed record ChainLoad(List<ImportedFile> Files, bool Complete, bool RootReadable);

    private sealed record CacheEntry(List<string> Files, string Stamp, PropertyTable Table);

    private sealed class PropertyTable
    {
        /// <summary>
        /// Names with exactly one distinct literal value, keyed upper-case because MSBuild property
        /// names are case-insensitive.
        /// </summary>
        public Dictionary<string, string> Literals { get; } = [];

        /// <summary>
        /// Names that were defined with a non-literal, empty or conflicting value, upper-case for
        /// the same reason.
        /// </summary>
        public HashSet<string> Ambiguous { get; } = [];
    }
}
