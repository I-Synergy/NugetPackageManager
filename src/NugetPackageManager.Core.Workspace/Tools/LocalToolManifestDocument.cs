namespace NugetPackageManager.Core.Workspace.Tools;

/// <summary>
/// One tool a local manifest declares, as read from
/// <c>.config/dotnet-tools.json</c>: the package id, the pinned version and the command
/// names the user actually types.
/// </summary>
public sealed record LocalToolDefinition
{
    /// <summary>The package id, which is also the key in the manifest's <c>tools</c> object.</summary>
    public required string Id { get; init; }

    /// <summary>The pinned package version, verbatim from the manifest.</summary>
    public required string Version { get; init; }

    /// <summary>The command names the manifest declares for this tool.</summary>
    public required IReadOnlyList<string> Commands { get; init; }

    /// <summary>
    /// <c>rollForward</c> from the manifest; <c>null</c> when absent or when .NET should
    /// apply its default. A literal <c>false</c> is a deliberate pin.
    /// </summary>
    public bool? RollForward { get; init; }

    /// <summary>True when the manifest pins the exact version (<c>rollForward: false</c>).</summary>
    public bool Pinned => RollForward == false;
}

/// <summary>
/// A parsed <c>.config/dotnet-tools.json</c>. <see cref="Text"/> and
/// <see cref="HasByteOrderMark"/> are kept so a rewrite can be a targeted edit of the original
/// bytes instead of a re-serialization.
/// </summary>
public sealed record LocalToolManifestDocument
{
    /// <summary>The absolute path the document was read from.</summary>
    public required string Path { get; init; }

    /// <summary>The manifest's own schema <c>version</c> (normally <c>1</c>); null when absent.</summary>
    public string? Version { get; init; }

    /// <summary><c>isRoot</c> from the manifest: this is the manifest <c>dotnet</c> picks.</summary>
    public bool IsRoot { get; init; }

    /// <summary>The declared tools, in manifest order.</summary>
    public required IReadOnlyList<LocalToolDefinition> Tools { get; init; }

    /// <summary>Whatever stops the manifest from being usable: bad JSON, missing fields, duplicates.</summary>
    public required IReadOnlyList<string> Problems { get; init; }

    /// <summary>True when the text parsed as JSON at all.</summary>
    public required bool Parsed { get; init; }

    /// <summary>The file's text exactly as read, without the byte-order mark.</summary>
    public required string Text { get; init; }

    /// <summary>True when the file starts with a UTF-8 byte-order mark.</summary>
    public required bool HasByteOrderMark { get; init; }

    /// <summary>True when the manifest parsed and reported no problems.</summary>
    public bool IsValid => Parsed && Problems.Count == 0;

    /// <summary>The tool with <paramref name="toolId"/>, or null.</summary>
    public LocalToolDefinition? FindTool(string toolId) =>
        Tools.FirstOrDefault(tool => string.Equals(tool.Id, toolId, StringComparison.Ordinal));
}
