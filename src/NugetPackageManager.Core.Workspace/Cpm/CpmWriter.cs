using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using NugetPackageManager.Common;

namespace NugetPackageManager.Core.Workspace.Cpm;


/// <summary>
/// Writes package versions into <c>Directory.Packages.props</c>.
///
/// This is a deliberate text-surgery port of <c>UpdateCpmVersionsAsync</c>: it edits only the
/// addressed <c>PackageVersion</c> tag so the user's formatting, ordering and comments survive,
/// verifies the result before writing, and replaces the file through a temporary file so a
/// failure never leaves a half-written props file.
///
/// When a version is written as a whole-value property reference (<c>Version="$(FooBarVersion)"</c>)
/// and MSBuild defines that property unconditionally in exactly one file inside a supplied
/// workspace root, the property definition is rewritten instead — the reference stays, so every
/// package using it moves together. Anything unsafe (conditional definitions, embedded
/// expressions, disagreeing projects, per-framework updates) falls back to the literal edit.
/// </summary>
public static partial class CpmWriter
{
    private static readonly SemaphoreSlim fileLock = new(1, 1);

    private const string ConditionAttribute = "Condition";
    private const string VerificationFailedCode = "verificationFailed";

    /// <summary>Upper bound for the pattern-based XML edits.</summary>
    private static readonly TimeSpan regexTimeout = TimeSpan.FromSeconds(2);

    /// <summary>
    /// Applies every change to the props file, and to whichever files define the properties those
    /// changes reference. Returns the absolute paths that were written.
    /// </summary>
    /// <param name="propsFilePath">The <c>Directory.Packages.props</c> that holds the versions.</param>
    /// <param name="changes">The versions to write.</param>
    /// <param name="cancellationToken">Cancels the update.</param>
    /// <param name="projectPaths">
    /// The projects governed by this props file, used to locate property definitions. Empty or
    /// <c>null</c> keeps every change on the literal path.
    /// </param>
    /// <param name="workspaceRoots">
    /// Directories a defining file must live inside before it is edited. Empty or <c>null</c> keeps
    /// every change on the literal path.
    /// </param>
    /// <param name="propertyLocator">
    /// Locates a property definition through MSBuild. <c>null</c> keeps every change on the literal
    /// path.
    /// </param>
    [SuppressMessage(
        "Design",
        "CA1068:CancellationToken parameters must come last",
        Justification = "The cancellation token keeps its original position so every existing call site stays source compatible; the new optional parameters follow it.")]
    public static async Task<IReadOnlyList<string>> UpdateVersionsAsync(
        string propsFilePath,
        IReadOnlyList<CpmVersionChange> changes,
        CancellationToken cancellationToken = default,
        IReadOnlyList<string>? projectPaths = null,
        IReadOnlyList<string>? workspaceRoots = null,
        ICpmPropertyLocator? propertyLocator = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(propsFilePath);
        ArgumentNullException.ThrowIfNull(changes);

        if (changes.Count == 0)
        {
            return [];
        }

        foreach (var change in changes)
        {
            ValidateChange(change);
        }

        await fileLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var plan = await CreatePlanAsync(
                propsFilePath, changes, projectPaths, workspaceRoots, propertyLocator, cancellationToken)
                .ConfigureAwait(false);

            var updatedProps = plan.Props.Content;
            foreach (var change in plan.LiteralChanges)
            {
                updatedProps = ApplyVersionChange(updatedProps, propsFilePath, change);
            }

            VerifyChanges(plan.Props.Content, updatedProps, propsFilePath, plan.LiteralChanges);
            plan.Props.Updated = updatedProps;

            ApplyPropertyEdits(plan);
            VerifyPropertyChanges(plan);

            List<string> written = [];
            foreach (var file in plan.ChangedFiles())
            {
                await WriteAsync(file.Path, file.Stamp, file.Updated, cancellationToken).ConfigureAwait(false);
                written.Add(file.Path);
            }

            return written;
        }
        finally
        {
            fileLock.Release();
        }
    }

    /// <summary>
    /// Every file <see cref="UpdateVersionsAsync"/> would write for these changes, resolved
    /// read-only so the caller can snapshot them before the first edit.
    ///
    /// The props file is included when a literal edit would change it; a defining file is included
    /// when its property value would change. A change the writer would reject still contributes the
    /// props file, so its snapshot covers the failed attempt.
    /// </summary>
    public static async Task<IReadOnlyList<string>> ResolveWriteTargetsAsync(
        string propsFilePath,
        IReadOnlyList<CpmVersionChange> changes,
        IReadOnlyList<string> projectPaths,
        IReadOnlyList<string> workspaceRoots,
        ICpmPropertyLocator? propertyLocator = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(propsFilePath);
        ArgumentNullException.ThrowIfNull(changes);
        ArgumentNullException.ThrowIfNull(projectPaths);
        ArgumentNullException.ThrowIfNull(workspaceRoots);

        if (changes.Count == 0)
        {
            return [];
        }

        var plan = await CreatePlanAsync(
            propsFilePath, changes, projectPaths, workspaceRoots, propertyLocator, cancellationToken)
            .ConfigureAwait(false);

        var updatedProps = plan.Props.Content;
        var propsTouched = false;
        foreach (var change in plan.LiteralChanges)
        {
            try
            {
                updatedProps = ApplyVersionChange(updatedProps, propsFilePath, change);
            }
            catch (WorkspaceException)
            {
                // The writer fails on this change; the props file still belongs in the snapshot.
                propsTouched = true;
            }
        }

        plan.Props.Updated = updatedProps;
        ApplyPropertyEdits(plan);

        List<string> targets = [];
        if (propsTouched || !string.Equals(plan.Props.Updated, plan.Props.Content, StringComparison.Ordinal))
        {
            targets.Add(plan.Props.Path);
        }

        foreach (var file in plan.PropertyFileValues)
        {
            if (string.Equals(file.Updated, file.Content, StringComparison.Ordinal))
            {
                continue;
            }

            if (!targets.Contains(file.Path, StringComparer.OrdinalIgnoreCase))
            {
                targets.Add(file.Path);
            }
        }

        return targets;
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
            var props = await ReadFileAsync(propsFilePath, cancellationToken).ConfigureAwait(false);
            var content = props.Content;
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

            await WriteAsync(propsFilePath, props.Stamp, updated, cancellationToken).ConfigureAwait(false);
            return true;
        }
        finally
        {
            fileLock.Release();
        }
    }

    /// <summary>Updates one package's version in the props file that governs a project.</summary>
    /// <param name="projectPath">The project whose props file is edited.</param>
    /// <param name="packageId">The package to update.</param>
    /// <param name="version">The new version.</param>
    /// <param name="condition">The <c>ItemGroup</c> condition, for a group-scoped update.</param>
    /// <param name="scope">How many occurrences to rewrite.</param>
    /// <param name="cancellationToken">Cancels the update.</param>
    /// <param name="options">
    /// The optional property-write settings: the workspace roots a defining file must live inside,
    /// and the locator that resolves a property definition. <c>null</c> keeps every change on the
    /// literal path.
    /// </param>
    [SuppressMessage(
        "Design",
        "CA1068:CancellationToken parameters must come last",
        Justification = "The cancellation token keeps its original position so every existing call site stays source compatible; the new optional parameter follows it.")]
    public static async Task<IReadOnlyList<string>> UpdatePackageVersionAsync(
        string projectPath,
        string packageId,
        string version,
        string? condition = null,
        CpmWriteScope? scope = null,
        CancellationToken cancellationToken = default,
        CpmWriteOptions? options = null)
    {
        var propsFilePath = CpmPropsReader.FindCpmFile(projectPath)
            ?? throw new WorkspaceException(
                "propsNotFound",
                $"Directory.Packages.props not found for {projectPath}");

        return await UpdateVersionsAsync(
            propsFilePath,
            [new CpmVersionChange(packageId, version, condition, scope)],
            cancellationToken,
            projectPaths: [projectPath],
            workspaceRoots: options?.WorkspaceRoots,
            propertyLocator: options?.PropertyLocator).ConfigureAwait(false);
    }

    public static bool IsValidPackageId(string value) => PackageIdRegex().IsMatch(value);

    public static bool IsValidNuGetVersion(string value) => VersionRegex().IsMatch(value);

    private static void ValidateChange(CpmVersionChange change)
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

    /// <summary>
    /// Decides, per change, whether it edits a property definition or a literal
    /// <c>PackageVersion</c> line, and reads every file that may be written.
    /// </summary>
    private static async Task<WritePlan> CreatePlanAsync(
        string propsFilePath,
        IReadOnlyList<CpmVersionChange> changes,
        IReadOnlyList<string>? projectPaths,
        IReadOnlyList<string>? workspaceRoots,
        ICpmPropertyLocator? propertyLocator,
        CancellationToken cancellationToken)
    {
        var props = await ReadFileAsync(propsFilePath, cancellationToken).ConfigureAwait(false);
        var plan = new WritePlan(props);

        foreach (var change in changes)
        {
            var edit = await ResolvePropertyEditAsync(
                plan, change, projectPaths, workspaceRoots, propertyLocator, cancellationToken)
                .ConfigureAwait(false);

            if (edit is null)
            {
                plan.LiteralChanges.Add(change);
            }
            else
            {
                plan.PropertyEdits.Add(edit);
            }
        }

        return plan;
    }

    /// <summary>
    /// The property edit for one change, or <c>null</c> when the change has to stay literal.
    ///
    /// Eligible only when the addressed occurrences are unconditional and all reference the same
    /// property, every supplied project resolves that property to the same file, that file is
    /// inside a workspace root, and it declares the property exactly once.
    /// </summary>
    private static async Task<PropertyEdit?> ResolvePropertyEditAsync(
        WritePlan plan,
        CpmVersionChange change,
        IReadOnlyList<string>? projectPaths,
        IReadOnlyList<string>? workspaceRoots,
        ICpmPropertyLocator? propertyLocator,
        CancellationToken cancellationToken)
    {
        // A per-framework update must not bump a shared property: that would move every
        // framework's version at once.
        if (!CanUsePropertyPath(change, projectPaths, workspaceRoots, propertyLocator))
        {
            return null;
        }

        List<(string Condition, string Version)> occurrences;
        try
        {
            occurrences = CollectOccurrences(plan.Props.Content, change.PackageId);
        }
        catch (XmlException)
        {
            return null;
        }

        var addressed = AddressedOccurrences(occurrences, change);
        if (!TryReadPropertyReferences(occurrences, addressed, out var propertyName, out var references))
        {
            return null;
        }

        var definition = await ResolveDefinitionAsync(
            projectPaths!, propertyName, propertyLocator!, cancellationToken)
            .ConfigureAwait(false);

        if (definition is null || !IsInsideWorkspaceRoot(definition.FilePath, workspaceRoots!))
        {
            return null;
        }

        var file = await ReadDefiningFileAsync(plan, definition.FilePath, cancellationToken).ConfigureAwait(false);
        if (file is null || CountPropertyElements(file.Content, definition.PropertyName) != 1)
        {
            return null;
        }

        return new PropertyEdit(
            file.Path, definition.PropertyName, change.PackageId, change.Version, references);
    }

    /// <summary>
    /// True when the change is even allowed to touch a property definition: a locator, projects and
    /// workspace roots are all supplied, and the update is not scoped to one framework.
    /// </summary>
    private static bool CanUsePropertyPath(
        CpmVersionChange change,
        IReadOnlyList<string>? projectPaths,
        IReadOnlyList<string>? workspaceRoots,
        ICpmPropertyLocator? propertyLocator) =>
        propertyLocator is not null
        && projectPaths is { Count: > 0 }
        && workspaceRoots is { Count: > 0 }
        && change.EffectiveScope != CpmWriteScope.Group;

    /// <summary>
    /// Reads the addressed occurrences as property references. False as soon as one is conditional,
    /// is not a whole-value property reference, or names a different property from the others.
    /// </summary>
    private static bool TryReadPropertyReferences(
        List<(string Condition, string Version)> occurrences,
        List<int> addressed,
        [NotNullWhen(true)] out string? propertyName,
        out List<(int Index, string RawVersion)> references)
    {
        propertyName = null;
        references = [];

        foreach (var index in addressed)
        {
            var occurrence = occurrences[index];
            if (occurrence.Condition.Length > 0)
            {
                return false;
            }

            var name = PropertyReference.GetPropertyName(occurrence.Version);
            if (name is null)
            {
                return false;
            }

            if (propertyName is null)
            {
                propertyName = name;
            }
            else if (!string.Equals(propertyName, name, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            references.Add((index, occurrence.Version));
        }

        return propertyName is not null;
    }

    /// <summary>The one definition every supplied project agrees on, or <c>null</c> when they disagree.</summary>
    private static async Task<PropertyDefinition?> ResolveDefinitionAsync(
        IReadOnlyList<string> projectPaths,
        string propertyName,
        ICpmPropertyLocator propertyLocator,
        CancellationToken cancellationToken)
    {
        PropertyDefinition? definition = null;

        foreach (var projectPath in projectPaths)
        {
            if (string.IsNullOrWhiteSpace(projectPath))
            {
                return null;
            }

            var located = await propertyLocator.LocateAsync(projectPath, propertyName, cancellationToken)
                .ConfigureAwait(false);

            if (located is null)
            {
                return null;
            }

            if (definition is null)
            {
                definition = located;
                continue;
            }

            if (!SamePath(definition.FilePath, located.FilePath)
                || !string.Equals(definition.PropertyName, located.PropertyName, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
        }

        return definition;
    }

    /// <summary>
    /// Reads a candidate defining file once, reusing the props draft when the property lives in the
    /// props file itself. A file that cannot be read disqualifies the property path.
    /// </summary>
    private static async Task<DraftFile?> ReadDefiningFileAsync(
        WritePlan plan,
        string filePath,
        CancellationToken cancellationToken)
    {
        if (SamePath(filePath, plan.Props.Path))
        {
            plan.AddPropertyFile(plan.Props);
            return plan.Props;
        }

        if (plan.TryGetPropertyFile(filePath, out var cached))
        {
            return cached;
        }

        try
        {
            var file = await ReadFileAsync(filePath, cancellationToken).ConfigureAwait(false);
            plan.AddPropertyFile(file);
            return file;
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The occurrence indices one change addresses, per its effective scope.</summary>
    private static List<int> AddressedOccurrences(
        List<(string Condition, string Version)> occurrences,
        CpmVersionChange change) =>
        change.EffectiveScope switch
        {
            CpmWriteScope.Group => GroupOccurrences(occurrences, change.Condition),
            CpmWriteScope.All => AllOccurrences(occurrences),
            CpmWriteScope.Unconditional => UnconditionalOccurrences(occurrences),
            CpmWriteScope.First or _ => FirstOccurrence(occurrences),
        };

    /// <summary>Every occurrence in the given condition; a change without one addresses nothing.</summary>
    private static List<int> GroupOccurrences(
        List<(string Condition, string Version)> occurrences,
        string? condition)
    {
        List<int> indices = [];
        if (condition is null)
        {
            return indices;
        }

        for (var index = 0; index < occurrences.Count; index++)
        {
            if (string.Equals(occurrences[index].Condition, condition, StringComparison.Ordinal))
            {
                indices.Add(index);
            }
        }

        return indices;
    }

    private static List<int> AllOccurrences(List<(string Condition, string Version)> occurrences)
    {
        List<int> indices = [];
        for (var index = 0; index < occurrences.Count; index++)
        {
            indices.Add(index);
        }

        return indices;
    }

    private static List<int> UnconditionalOccurrences(List<(string Condition, string Version)> occurrences)
    {
        List<int> indices = [];
        for (var index = 0; index < occurrences.Count; index++)
        {
            if (occurrences[index].Condition.Length == 0)
            {
                indices.Add(index);
            }
        }

        return indices;
    }

    /// <summary>Just the first occurrence, which is what a plain update rewrites.</summary>
    private static List<int> FirstOccurrence(List<(string Condition, string Version)> occurrences) =>
        occurrences.Count > 0 ? [0] : [];

    private static void ApplyPropertyEdits(WritePlan plan)
    {
        foreach (var edit in plan.PropertyEdits)
        {
            var file = plan.PropertyFile(edit.FilePath);
            file.Updated = ApplyPropertyEdit(file.Updated, edit);
        }
    }

    /// <summary>
    /// Replaces the text value of one property element, leaving its tag, its attributes,
    /// surrounding whitespace and the rest of the file byte-for-byte intact.
    /// </summary>
    private static string ApplyPropertyEdit(string content, PropertyEdit edit)
    {
        var name = Regex.Escape(edit.PropertyName);
        var pattern = new Regex(
            $@"(?<open><{name}(?:\s[^>]*)?>)(?<value>[^<]*)(?<close></{name}\s*>)",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant,
            regexTimeout);

        return pattern.Replace(
            content,
            match => string.Concat(
                match.Groups["open"].Value,
                ReplaceInnerValue(match.Groups["value"].Value, edit.NewVersion),
                match.Groups["close"].Value),
            count: 1);
    }

    /// <summary>Swaps the trimmed value, keeping the whitespace the user put around it.</summary>
    private static string ReplaceInnerValue(string innerValue, string newVersion)
    {
        var start = 0;
        while (start < innerValue.Length && char.IsWhiteSpace(innerValue[start]))
        {
            start++;
        }

        var end = innerValue.Length;
        while (end > start && char.IsWhiteSpace(innerValue[end - 1]))
        {
            end--;
        }

        return string.Concat(innerValue[..start], newVersion, innerValue[end..]);
    }

    private static void VerifyPropertyChanges(WritePlan plan)
    {
        foreach (var edit in plan.PropertyEdits)
        {
            var before = CollectOccurrences(plan.Props.Content, edit.PackageId);
            var after = CollectOccurrences(plan.Props.Updated, edit.PackageId);

            if (before.Count != after.Count)
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed: element count for {edit.PackageId} changed in {plan.Props.Path}");
            }

            foreach (var (index, rawVersion) in edit.References)
            {
                var actual = index < after.Count ? after[index].Version : string.Empty;
                if (!string.Equals(actual, rawVersion, StringComparison.Ordinal))
                {
                    throw new WorkspaceException(
                        VerificationFailedCode,
                        $"Verification failed for {edit.PackageId}: expected the reference {rawVersion}, got {actual} in {plan.Props.Path}");
                }
            }
        }

        // The last edit of one property wins, because the edits are applied in order.
        var finals = plan.PropertyEdits
            .GroupBy(edit => (File: edit.FilePath.ToUpperInvariant(), Name: edit.PropertyName.ToUpperInvariant()))
            .Select(group => group.Last());

        foreach (var edit in finals)
        {
            var file = plan.PropertyFile(edit.FilePath);
            if (CountPropertyElements(file.Content, edit.PropertyName) != CountPropertyElements(file.Updated, edit.PropertyName))
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed: property count for {edit.PropertyName} changed in {file.Path}");
            }

            var value = PropertyElementValue(file.Updated, edit.PropertyName);
            if (!string.Equals(value, edit.NewVersion, StringComparison.Ordinal))
            {
                throw new WorkspaceException(
                    VerificationFailedCode,
                    $"Verification failed for {edit.PropertyName}: expected {edit.NewVersion}, got {value} in {file.Path}");
            }
        }
    }

    /// <summary>How many elements in the document carry this property name.</summary>
    private static int CountPropertyElements(string content, string propertyName)
    {
        var document = TryParse(content);
        return document is null
            ? 0
            : document.Descendants().Count(element =>
                element.Name.LocalName.Equals(propertyName, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>The trimmed value of the single element with this name, or null.</summary>
    private static string? PropertyElementValue(string content, string propertyName)
    {
        var document = TryParse(content);
        return document?
            .Descendants()
            .LastOrDefault(element => element.Name.LocalName.Equals(propertyName, StringComparison.OrdinalIgnoreCase))
            ?.Value.Trim();
    }

    private static XDocument? TryParse(string content)
    {
        try
        {
            return XDocument.Parse(content);
        }
        catch (XmlException)
        {
            return null;
        }
    }

    /// <summary>True when the file lives inside one of the roots; the guard before any property edit.</summary>
    private static bool IsInsideWorkspaceRoot(string filePath, IReadOnlyList<string> workspaceRoots)
    {
        var file = Normalize(filePath);
        if (file is null)
        {
            return false;
        }

        foreach (var root in workspaceRoots)
        {
            var normalizedRoot = Normalize(root);
            if (string.IsNullOrEmpty(normalizedRoot))
            {
                continue;
            }

            if (file.StartsWith(normalizedRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || file.StartsWith(normalizedRoot + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool SamePath(string left, string right)
    {
        var normalizedLeft = Normalize(left);
        var normalizedRight = Normalize(right);
        return normalizedLeft is not null
            && normalizedRight is not null
            && string.Equals(normalizedLeft, normalizedRight, StringComparison.OrdinalIgnoreCase);
    }

    private static string? Normalize(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return null;
        }

        try
        {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
        catch (ArgumentException)
        {
            return null;
        }
        catch (NotSupportedException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
    }

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
        var document = XDocument.Parse(cpmContent);
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

    private static async Task<DraftFile> ReadFileAsync(string path, CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        var content = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
        return new DraftFile(path, content, info.LastWriteTimeUtc);
    }

    /// <summary>
    /// Refuses to overwrite a file that changed while the update was prepared, then replaces it
    /// through a temporary file in the same directory so the swap is atomic.
    /// </summary>
    private static async Task WriteAsync(
        string path,
        DateTime expectedStamp,
        string content,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        info.Refresh();

        if (info.LastWriteTimeUtc != expectedStamp)
        {
            throw new WorkspaceException(
                "fileChanged",
                $"{path} changed while the update was being prepared; retry the operation");
        }

        var tempPath = path + "." + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ".tmp";
        try
        {
            await File.WriteAllTextAsync(tempPath, content, cancellationToken).ConfigureAwait(false);
            File.Move(tempPath, path, overwrite: true);
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

    /// <summary>One file the update may touch: its content as read, and as it would be written.</summary>
    private sealed class DraftFile(string path, string content, DateTime stamp)
    {
        public string Path { get; } = path;

        public string Content { get; } = content;

        public DateTime Stamp { get; } = stamp;

        public string Updated { get; set; } = content;
    }

    /// <summary>The resolved shape of one update: literals for the props file, edits for properties.</summary>
    private sealed class WritePlan(DraftFile props)
    {
        private readonly Dictionary<string, DraftFile> propertyFiles = [];

        public DraftFile Props { get; } = props;

        public List<CpmVersionChange> LiteralChanges { get; } = [];

        public List<PropertyEdit> PropertyEdits { get; } = [];

        /// <summary>Every candidate defining file, in discovery order.</summary>
        public IEnumerable<DraftFile> PropertyFileValues => propertyFiles.Values;

        public void AddPropertyFile(DraftFile file) => propertyFiles[Key(file.Path)] = file;

        public bool TryGetPropertyFile(string path, [NotNullWhen(true)] out DraftFile? file) =>
            propertyFiles.TryGetValue(Key(path), out file);

        public DraftFile PropertyFile(string path) => propertyFiles[Key(path)];

        /// <summary>The files whose content actually changed, props file first.</summary>
        public IEnumerable<DraftFile> ChangedFiles() =>
            propertyFiles.Values
                .Prepend(Props)
                .Distinct()
                .Where(file => !string.Equals(file.Updated, file.Content, StringComparison.Ordinal));

        private static string Key(string path) => Normalize(path) ?? path;
    }

    /// <summary>One property value to rewrite, plus the references that must stay untouched.</summary>
    private sealed record PropertyEdit(
        string FilePath,
        string PropertyName,
        string PackageId,
        string NewVersion,
        IReadOnlyList<(int Index, string RawVersion)> References);

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
