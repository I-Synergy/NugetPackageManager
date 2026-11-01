using System.Diagnostics;
using System.Globalization;
using System.Xml;
using System.Xml.Linq;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>
/// Default <see cref="ICpmPropertyLocator"/>: runs <c>dotnet msbuild -pp</c>, which writes the
/// project with every import expanded and each import wrapped in a boundary comment that names
/// the imported file. That maps a property definition back to the file that really declares it,
/// including a definition in <c>Directory.Build.props</c> or an imported <c>.props</c>.
///
/// The spawn is expensive, so results are cached (bounded) and keyed on the project plus the
/// timestamps of the files whose edits change the preprocessed output. Any failure — non-zero
/// exit, timeout, unreadable output — yields <c>null</c>, and the writer then keeps the literal
/// <c>PackageVersion</c> edit.
/// </summary>
public sealed class CpmPropertyLocator : ICpmPropertyLocator, IDisposable
{
    private const int MaxCacheEntries = 500;
    private const string DotnetExecutableName = "dotnet";
    private const string ConditionAttribute = "Condition";
    private const string ImportOpenTag = "<Import";
    private const string ImportCloseTag = "</Import";
    private const string PropertyGroupElement = "PropertyGroup";
    private const string TargetElement = "Target";
    private static readonly TimeSpan locatorTimeout = TimeSpan.FromSeconds(60);

    private readonly SemaphoreSlim locatorSlots = new(16, 16);
    private readonly Dictionary<string, CacheEntry> cache = [];
    private readonly object cacheLock = new();

    private sealed record CacheEntry(string FileStamp, PropertyDefinition? Definition);

    public async Task<PropertyDefinition?> LocateAsync(
        string projectPath,
        string propertyName,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(propertyName);

        var cacheKey = string.Concat(projectPath, "|", propertyName);
        var stamp = BuildStamp(projectPath);
        lock (cacheLock)
        {
            if (cache.TryGetValue(cacheKey, out var cached) && cached.FileStamp == stamp)
            {
                return cached.Definition;
            }
        }

        var definition = await RunAsync(projectPath, propertyName, cancellationToken).ConfigureAwait(false);

        lock (cacheLock)
        {
            if (cache.Count >= MaxCacheEntries)
            {
                cache.Clear();
            }

            cache[cacheKey] = new CacheEntry(stamp, definition);
        }

        return definition;
    }

    private async Task<PropertyDefinition?> RunAsync(
        string projectPath,
        string propertyName,
        CancellationToken cancellationToken)
    {
        await locatorSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            // The preprocessed output is a throw-away diagnostic dump: it never belongs inside
            // the workspace, so it goes to the system temp directory and is deleted here.
            var tempPath = Path.Combine(
                Path.GetTempPath(),
                string.Concat("cpm-property-locator-", Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture), ".xml"));

            try
            {
                var startInfo = new ProcessStartInfo
                {
                    FileName = DotnetHost(),
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(projectPath) ?? Environment.CurrentDirectory,
                };

                startInfo.ArgumentList.Add("msbuild");
                startInfo.ArgumentList.Add(projectPath);
                startInfo.ArgumentList.Add(string.Concat("-pp:", tempPath));
                startInfo.ArgumentList.Add("-nologo");

                using var process = Process.Start(startInfo);
                if (process is null)
                {
                    return null;
                }

                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(locatorTimeout);

                try
                {
                    // Read stderr to completion so the child never blocks on a full pipe.
                    var errorTask = process.StandardError.ReadToEndAsync(timeout.Token);
                    await process.StandardOutput.ReadToEndAsync(timeout.Token).ConfigureAwait(false);
                    await errorTask.ConfigureAwait(false);
                    await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    TryKill(process);
                    return null;
                }

                if (process.ExitCode != 0 || !File.Exists(tempPath))
                {
                    return null;
                }

                string xml;
                try
                {
                    xml = await File.ReadAllTextAsync(tempPath, cancellationToken).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    return null;
                }
                catch (UnauthorizedAccessException)
                {
                    return null;
                }

                return ParsePreprocessed(xml, projectPath, propertyName);
            }
            finally
            {
                DeleteQuietly(tempPath);
            }
        }
        finally
        {
            locatorSlots.Release();
        }
    }

    /// <summary>
    /// Reads one definition out of preprocessed output: the last unconditional
    /// <paramref name="propertyName"/> element in document order, attributed to the file the import
    /// boundary comments say owns it. Returns <c>null</c> when no such definition exists.
    /// </summary>
    internal static PropertyDefinition? ParsePreprocessed(string xml, string projectPath, string propertyName)
    {
        ArgumentNullException.ThrowIfNull(xml);
        ArgumentException.ThrowIfNullOrWhiteSpace(projectPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(propertyName);

        XDocument document;
        try
        {
            document = XDocument.Parse(xml);
        }
        catch (XmlException)
        {
            return null;
        }

        var walker = new PreprocessedWalker(projectPath, propertyName);
        walker.Walk(document, insideTarget: false, conditionalAncestor: false);
        return walker.Winner;
    }

    /// <summary>
    /// The recursive document walk behind <see cref="ParsePreprocessed"/>: tracks the import stack the
    /// boundary comments build and keeps the last unconditional definition it sees.
    /// </summary>
    private sealed class PreprocessedWalker(string projectPath, string propertyName)
    {
        private readonly Stack<string> importedFiles = new();

        /// <summary>The last accepted definition, or <c>null</c> when the walk found none.</summary>
        public PropertyDefinition? Winner { get; private set; }

        /// <summary>Visits one container in document order, descending into every element.</summary>
        public void Walk(XContainer container, bool insideTarget, bool conditionalAncestor)
        {
            foreach (var node in container.Nodes())
            {
                if (node is XComment comment)
                {
                    ApplyBoundary(comment, importedFiles);
                    continue;
                }

                if (node is not XElement element)
                {
                    continue;
                }

                var isTarget = insideTarget
                    || element.Name.LocalName.Equals(TargetElement, StringComparison.OrdinalIgnoreCase);
                var conditional = conditionalAncestor || HasCondition(element);

                if (!isTarget
                    && !conditional
                    && IsDefinition(element, container, propertyName))
                {
                    var filePath = importedFiles.Count > 0 ? importedFiles.Peek() : projectPath;
                    Winner = new PropertyDefinition(filePath, element.Name.LocalName, element.Value.Trim());
                }

                Walk(element, isTarget, conditional);
            }
        }
    }

    /// <summary>A property element: the requested name, directly inside a <c>PropertyGroup</c>.</summary>
    private static bool IsDefinition(XElement element, XContainer container, string propertyName) =>
        container is XElement parent
        && parent.Name.LocalName.Equals(PropertyGroupElement, StringComparison.OrdinalIgnoreCase)
        && element.Name.LocalName.Equals(propertyName, StringComparison.OrdinalIgnoreCase);

    private static bool HasCondition(XElement element) =>
        element.Attributes().Any(attribute =>
            attribute.Name.LocalName.Equals(ConditionAttribute, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Tracks the import stack from one boundary comment. Such a comment holds the <c>&lt;Import&gt;</c>
    /// (or <c>&lt;/Import&gt;</c>) line, possibly a description, and the resolved file path; the last
    /// non-markup line is the path.
    /// </summary>
    private static void ApplyBoundary(XComment comment, Stack<string> importedFiles)
    {
        var opens = false;
        var closes = false;
        var candidates = new List<string>();

        foreach (var rawLine in comment.Value.Split('\n'))
        {
            var line = rawLine.Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (IsMarkupLine(line))
            {
                ReadMarkupLine(line, ref opens, ref closes);
                continue;
            }

            if (!IsSeparator(line))
            {
                candidates.Add(line);
            }
        }

        if (opens && candidates.Count > 0)
        {
            importedFiles.Push(candidates[^1]);
        }
        else if (closes && importedFiles.Count > 0)
        {
            importedFiles.Pop();
        }
    }

    /// <summary>True when the trimmed comment line is XML markup rather than the resolved path.</summary>
    private static bool IsMarkupLine(string line) => line.StartsWith('<');

    /// <summary>
    /// Classifies one markup line: a close tag closes the import, and an opening tag that is not
    /// self-closing (<c>/&gt;</c>) opens it. Anything else, such as a self-closing import, is ignored.
    /// </summary>
    private static void ReadMarkupLine(string line, ref bool opens, ref bool closes)
    {
        if (line.StartsWith(ImportCloseTag, StringComparison.OrdinalIgnoreCase))
        {
            closes = true;
        }
        else if (line.StartsWith(ImportOpenTag, StringComparison.OrdinalIgnoreCase)
            && !line.EndsWith("/>", StringComparison.Ordinal))
        {
            opens = true;
        }
    }

    /// <summary>A banner line made only of <c>=</c> or <c>*</c>.</summary>
    private static bool IsSeparator(string line) =>
        line.All(character => character is '=' or '*');

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process already exited between the check and the kill.
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The process could not be killed; nothing else to do.
        }
    }

    private static void DeleteQuietly(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (IOException)
        {
            // A leftover temp file must not fail an otherwise successful update.
        }
        catch (UnauthorizedAccessException)
        {
            // Same.
        }
    }

    /// <summary>
    /// Absolute path of the <c>dotnet</c> host to run, resolved the same way as
    /// <see cref="CpmEvaluator"/>: the sidecar's own image when it is the muxer, otherwise
    /// <c>DOTNET_HOST_PATH</c>, otherwise <c>dotnet</c> on PATH.
    /// </summary>
    private static string DotnetHost()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrEmpty(processPath)
            && Path.GetFileNameWithoutExtension(processPath).Equals(DotnetExecutableName, StringComparison.OrdinalIgnoreCase))
        {
            return processPath;
        }

        var hostPath = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
        return string.IsNullOrEmpty(hostPath) ? DotnetExecutableName : hostPath;
    }

    private static string BuildStamp(string projectPath)
    {
        var parts = new List<string> { Stamp(projectPath) };

        var cpmFile = CpmPropsReader.FindCpmFile(projectPath);
        if (cpmFile is not null)
        {
            parts.Add(Stamp(cpmFile));
        }

        var directory = Path.GetDirectoryName(projectPath);
        if (directory is not null)
        {
            parts.Add(Stamp(Path.Combine(directory, "Directory.Build.props")));
            parts.Add(Stamp(Path.Combine(directory, "Directory.Build.targets")));
        }

        return string.Join('|', parts);
    }

    private static string Stamp(string path) =>
        File.Exists(path)
            ? File.GetLastWriteTimeUtc(path).ToString("O", CultureInfo.InvariantCulture)
            : "missing";

    public void Dispose() => locatorSlots.Dispose();
}
