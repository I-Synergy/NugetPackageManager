using System.Globalization;
using System.Text.RegularExpressions;

namespace NugetPackageManager.Core.Workspace.Cpm;

/// <summary>Where a CPM write is allowed to land.</summary>
public enum CpmWriteScope
{
    /// <summary>The <c>ItemGroup</c> whose combined condition matches.</summary>
    Group,

    /// <summary>Every unconditional <c>ItemGroup</c>.</summary>
    Unconditional,

    /// <summary>Every occurrence, conditional or not.</summary>
    All,

    /// <summary>Only the first matching element.</summary>
    First,
}


/// <summary>
/// Writes package versions into <c>Directory.Packages.props</c>.
///
/// This is a deliberate text-surgery port of <c>UpdateCpmVersionsAsync</c>: it edits only the
/// addressed <c>PackageVersion</c> tag so the user's formatting, ordering and comments survive,
/// verifies the result before writing, and replaces the file through a temporary file so a
/// failure never leaves a half-written props file.
/// </summary>
public static partial class CpmWriter
{
    private static readonly SemaphoreSlim fileLock = new(1, 1);

    private const string ConditionAttribute = "Condition";
    private const string VerificationFailedCode = "verificationFailed";

    /// <summary>Upper bound for the pattern-based XML edits.</summary>
    private static readonly TimeSpan regexTimeout = TimeSpan.FromSeconds(2);

    public static async Task UpdateVersionsAsync(
        string propsFilePath,
        IReadOnlyList<CpmVersionChange> changes,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(propsFilePath);
        ArgumentNullException.ThrowIfNull(changes);

        if (changes.Count == 0)
        {
            return;
        }

        foreach (var change in changes)
        {
            if (!IsValidPackageId(change.PackageId))
            {
                throw new WorkspaceException("invalidPackageId", $"Invalid NuGet package ID: {change.PackageId}");
            }

            if (!IsValidNuGetVersion(change.Version))
            {
                throw new WorkspaceException(
                    "invalidVersion",
                    $"Invalid NuGet version for {change.PackageId}: {change.Version}");
            }
        }

        await fileLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var (content, stamp) = await ReadAsync(propsFilePath, cancellationToken).ConfigureAwait(false);

            var updated = content;
            foreach (var change in changes)
            {
                updated = ApplyVersionChange(updated, propsFilePath, change);
            }

            VerifyChanges(content, updated, propsFilePath, changes);
            await WriteAsync(propsFilePath, stamp, updated, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            fileLock.Release();
        }
    }

    /// <summary>Removes every <c>PackageVersion</c> entry for a package. False when none existed.</summary>
    public static async Task<bool> RemovePackageVersionAsync(
        string propsFilePath,
        string packageId,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(propsFilePath);
        if (!IsValidPackageId(packageId))
        {
            throw new WorkspaceException("invalidPackageId", $"Invalid NuGet package ID: {packageId}");
        }

        await fileLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var (content, stamp) = await ReadAsync(propsFilePath, cancellationToken).ConfigureAwait(false);
            var escaped = Regex.Escape(packageId);

            var elementPattern = new Regex(
                $@"[ \t]*<PackageVersion\b[^>]*\bInclude\s*=\s*(""{escaped}""|'{escaped}')[^>]*(?:/>|>\s*</PackageVersion>)[ \t]*(?:\r?\n)?",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, regexTimeout);

            var updated = elementPattern.Replace(content, string.Empty);
            if (string.Equals(updated, content, StringComparison.Ordinal))
            {
                return false;
            }

            var remaining = new Regex(
                $@"<PackageVersion\b[^>]*\bInclude\s*=\s*(""{escaped}""|'{escaped}')",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, regexTimeout);

            if (remaining.IsMatch(updated))
            {
                throw new WorkspaceException(
                    "writeFailed",
                    $"Failed to remove all PackageVersion entries for {packageId} from {propsFilePath}");
            }

            await WriteAsync(propsFilePath, stamp, updated, cancellationToken).ConfigureAwait(false);
            return true;
        }
        finally
        {
            fileLock.Release();
        }
    }

    /// <summary>Updates one package's version in the props file that governs a project.</summary>
    public static async Task UpdatePackageVersionAsync(
        string projectPath,
        string packageId,
        string version,
        string? condition = null,
        CpmWriteScope? scope = null,
        CancellationToken cancellationToken = default)
    {
        var propsFilePath = CpmPropsReader.FindCpmFile(projectPath)
            ?? throw new WorkspaceException(
                "propsNotFound",
                $"Directory.Packages.props not found for {projectPath}");

        await UpdateVersionsAsync(propsFilePath, [new CpmVersionChange(packageId, version, condition, scope)],
            cancellationToken).ConfigureAwait(false);
    }

    public static bool IsValidPackageId(string value) => PackageIdRegex().IsMatch(value);

    public static bool IsValidNuGetVersion(string value) => VersionRegex().IsMatch(value);

    private static string ApplyVersionChange(string content, string propsFilePath, CpmVersionChange change)
    {
        var scope = change.EffectiveScope;

        if (scope == CpmWriteScope.Group)
        {
            var condition = change.Condition
                ?? throw new WorkspaceException(
                    "invalidParams",
                    $"A condition is required for scoped CPM updates in {propsFilePath}");

            var conditional = ReplaceConditionalElement(content, change.PackageId, change.Version, condition);
            return conditional.Changed
                ? conditional.Text
                : throw new WorkspaceException(
                    "packageNotFound",
                    $"Package {change.PackageId} not found in ItemGroup with Condition=\"{condition}\" in {propsFilePath}");
        }

        if (scope == CpmWriteScope.Unconditional)
        {
            var unconditional = ReplaceUnconditionalElements(content, change.PackageId, change.Version);
            return unconditional.Changed
                ? unconditional.Text
                : throw new WorkspaceException(
                    "packageNotFound",
                    $"Package {change.PackageId} not found in an unconditional ItemGroup in {propsFilePath}");
        }

        var updated = ReplaceInElements(content, change.PackageId, change.Version, scope == CpmWriteScope.All);
        return updated.Changed
            ? updated.Text
            : throw new WorkspaceException(
                "packageNotFound",
                $"Package {change.PackageId} not found in {propsFilePath}");
    }

    private static (string Text, bool Changed) ReplaceConditionalElement(
        string content,
        string packageId,
        string newVersion,
        string condition)
    {
        foreach (var block in FindItemGroupBlocks(content))
        {
            var result = ReplaceInBody(
                block.Body,
                packageId,
                newVersion,
                tag => CombineConditions(block.Condition, (Attribute(tag, ConditionAttribute) ?? string.Empty).Trim()) == condition,
                global: false);

            if (!result.Changed)
            {
                continue;
            }

            return (
                content[..block.Start] + block.OpenTag + result.Text + block.CloseTag + content[block.End..],
                true);
        }

        return (content, false);
    }

    private static (string Text, bool Changed) ReplaceUnconditionalElements(
        string content,
        string packageId,
        string newVersion)
    {
        var updated = content;
        var changedAny = false;

        var blocks = FindItemGroupBlocks(content)
            .Where(block => block.Condition.Length == 0)
            .Reverse()
            .ToList();

        foreach (var block in blocks)
        {
            var result = ReplaceInBody(
                block.Body,
                packageId,
                newVersion,
                tag => Attribute(tag, ConditionAttribute) is null,
                global: true);

            if (!result.Changed)
            {
                continue;
            }

            changedAny = true;
            updated = updated[..block.Start] + block.OpenTag + result.Text + block.CloseTag + updated[block.End..];
        }

        return (updated, changedAny);
    }

    private static (string Text, bool Changed) ReplaceInBody(
        string body,
        string packageId,
        string newVersion,
        Func<string, bool> predicate,
        bool global)
    {
        var changed = false;
        var output = new System.Text.StringBuilder();
        var lastIndex = 0;

        foreach (Match match in PackageVersionTagRegex().Matches(body))
        {
            var tag = match.Value;
            var include = Attribute(tag, "Include");

            if (include is null
                || !string.Equals(include, packageId, StringComparison.OrdinalIgnoreCase)
                || !predicate(tag))
            {
                continue;
            }

            if (!VersionAttributeRegex().IsMatch(tag))
            {
                continue;
            }

            output.Append(body, lastIndex, match.Index - lastIndex).Append(ReplaceVersion(tag, newVersion));
            lastIndex = match.Index + tag.Length;
            changed = true;

            if (!global)
            {
                break;
            }
        }

        if (!changed)
        {
            return (body, false);
        }

        output.Append(body, lastIndex, body.Length - lastIndex);
        return (output.ToString(), true);
    }

    private static (string Text, bool Changed) ReplaceInElements(
        string content,
        string packageId,
        string newVersion,
        bool global)
    {
        var changed = false;

        var result = PackageVersionTagRegex().Replace(content, match =>
        {
            if (changed && !global)
            {
                return match.Value;
            }

            var tag = match.Value;
            var include = Attribute(tag, "Include");

            if (include is null || !string.Equals(include, packageId, StringComparison.OrdinalIgnoreCase))
            {
                return tag;
            }

            if (!VersionAttributeRegex().IsMatch(tag))
            {
                return tag;
            }

            changed = true;
            return ReplaceVersion(tag, newVersion);
        });

        return (result, changed);
    }

    /// <summary>Swaps the quoted version, keeping the original quote character.</summary>
    private static string ReplaceVersion(string tag, string newVersion) =>
        VersionAttributeRegex().Replace(tag, match =>
        {
            var quoted = match.Groups[2].Value;
            var quote = quoted.StartsWith('\'') ? "'" : "\"";
            return $"{match.Groups[1].Value}{quote}{newVersion}{quote}";
        });

    private static void VerifyChanges(
        string originalContent,
        string updatedContent,
        string propsFilePath,
        IReadOnlyList<CpmVersionChange> changes)
    {
        foreach (var group in changes.GroupBy(change => change.PackageId.ToLowerInvariant()))
        {
            var packageChanges = group.ToList();
            var packageId = packageChanges[0].PackageId;
            var before = CollectOccurrences(originalContent, packageId);
            var after = CollectOccurrences(updatedContent, packageId);

            if (before.Count == 0)
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed: {packageId} missing from {propsFilePath}");
            }

            if (before.Count != after.Count)
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed: element count for {packageId} changed in {propsFilePath}");
            }

            List<string> expected = [.. before.Select(occurrence => occurrence.Version)];
            foreach (var change in packageChanges)
            {
                ApplyExpectedChange(expected, before, change, packageId, propsFilePath);
            }

            for (var index = 0; index < after.Count; index++)
            {
                if (!string.Equals(after[index].Version, expected[index], StringComparison.Ordinal))
                {
                    throw new WorkspaceException(
                        VerificationFailedCode,
                        $"Verification failed for {packageId}: occurrence {index} expected {expected[index]}, got {after[index].Version} in {propsFilePath}");
                }
            }
        }
    }

    private static void ApplyExpectedChange(
        List<string> expected,
        List<(string Condition, string Version)> before,
        CpmVersionChange change,
        string packageId,
        string propsFilePath)
    {
        var scope = change.EffectiveScope;

        if (scope == CpmWriteScope.Group)
        {
            var condition = change.Condition
                ?? throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed for {packageId}: a condition is required for a group-scoped update in {propsFilePath}");

            var index = before.FindIndex(occurrence => occurrence.Condition == condition);
            if (index < 0)
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed for {packageId}: Condition=\"{condition}\" produced no occurrences in {propsFilePath}");
            }

            expected[index] = change.Version;
            return;
        }

        if (scope == CpmWriteScope.Unconditional)
        {
            var indices = before
                .Select((occurrence, index) => (occurrence, index))
                .Where(entry => entry.occurrence.Condition.Length == 0)
                .Select(entry => entry.index)
                .ToList();

            if (indices.Count == 0)
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed for {packageId}: no unconditional occurrence in {propsFilePath}");
            }

            foreach (var index in indices)
            {
                expected[index] = change.Version;
            }

            return;
        }

        if (scope == CpmWriteScope.All)
        {
            for (var index = 0; index < expected.Count; index++)
            {
                expected[index] = change.Version;
            }

            return;
        }

        // "first": ReplaceInElements rewrites exactly the first matching element.
        expected[0] = change.Version;
    }

    private static List<(string Condition, string Version)> CollectOccurrences(string cpmContent, string packageId)
    {
        var occurrences = new List<(string Condition, string Version)>();

        // Walk the document with the same tolerance as the parser: local names, no namespace.
        var document = System.Xml.Linq.XDocument.Parse(cpmContent);
        foreach (var group in document.Descendants().Where(element => element.Name.LocalName == "ItemGroup"))
        {
            var groupCondition = (group.Attribute(ConditionAttribute)?.Value ?? string.Empty).Trim();

            foreach (var element in group.Elements().Where(child => child.Name.LocalName == "PackageVersion"))
            {
                var include = element.Attribute("Include")?.Value;
                var version = element.Attribute("Version")?.Value;
                var elementCondition = (element.Attribute(ConditionAttribute)?.Value ?? string.Empty).Trim();

                if (include is not null
                    && version is not null
                    && string.Equals(include, packageId, StringComparison.OrdinalIgnoreCase))
                {
                    occurrences.Add((CombineConditions(groupCondition, elementCondition), version));
                }
            }
        }

        return occurrences;
    }

    private static List<ItemGroupBlock> FindItemGroupBlocks(string content) =>
        [.. ItemGroupRegex().Matches(content)
            .Select(match => new ItemGroupBlock(
                (Attribute(match.Groups[1].Value, ConditionAttribute) ?? string.Empty).Trim(),
                match.Index,
                match.Index + match.Length,
                $"<ItemGroup{match.Groups[1].Value}>",
                match.Groups[2].Value,
                "</ItemGroup>"))];

    internal static string CombineConditions(string groupCondition, string elementCondition)
    {
        if (groupCondition.Length == 0)
        {
            return elementCondition;
        }

        return elementCondition.Length == 0
            ? groupCondition
            : $"({groupCondition}) And ({elementCondition})";
    }

    /// <summary>A quoted attribute value from an XML tag, or null.</summary>
    internal static string? Attribute(string tag, string name)
    {
        var pattern = new Regex(
            $@"\b{Regex.Escape(name)}\s*=\s*(?:""([^""]*)""|'([^']*)')",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, regexTimeout);

        var match = pattern.Match(tag);
        if (!match.Success)
        {
            return null;
        }

        return match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
    }

    private static async Task<(string Content, DateTime Stamp)> ReadAsync(
        string propsFilePath,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(propsFilePath);
        var content = await File.ReadAllTextAsync(propsFilePath, cancellationToken).ConfigureAwait(false);
        return (content, info.LastWriteTimeUtc);
    }

    /// <summary>
    /// Refuses to overwrite a file that changed while the update was prepared, then replaces it
    /// through a temporary file in the same directory so the swap is atomic.
    /// </summary>
    private static async Task WriteAsync(
        string propsFilePath,
        DateTime expectedStamp,
        string content,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(propsFilePath);
        info.Refresh();

        if (info.LastWriteTimeUtc != expectedStamp)
        {
            throw new WorkspaceException(
                "fileChanged",
                $"{propsFilePath} changed while the update was being prepared; retry the operation");
        }

        var tempPath = propsFilePath + "." + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ".tmp";
        try
        {
            await File.WriteAllTextAsync(tempPath, content, cancellationToken).ConfigureAwait(false);
            File.Move(tempPath, propsFilePath, overwrite: true);
        }
        catch
        {
            if (File.Exists(tempPath))
            {
                File.Delete(tempPath);
            }

            throw;
        }
    }

    private sealed record ItemGroupBlock(
        string Condition,
        int Start,
        int End,
        string OpenTag,
        string Body,
        string CloseTag);

    [GeneratedRegex(@"<PackageVersion\b[^>]*?/?>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex PackageVersionTagRegex();

    [GeneratedRegex(@"<ItemGroup\b([^>]*)>([\s\S]*?)</ItemGroup>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ItemGroupRegex();

    [GeneratedRegex(@"(\bVersion\s*=\s*)(""[^""]*""|'[^']*')", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex VersionAttributeRegex();

    [GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$", RegexOptions.CultureInvariant)]
    private static partial Regex PackageIdRegex();

    [GeneratedRegex(@"^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex VersionRegex();
}
