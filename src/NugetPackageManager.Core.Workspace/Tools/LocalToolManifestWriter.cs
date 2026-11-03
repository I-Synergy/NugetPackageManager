using System.Globalization;
using System.Text;
using System.Text.Json;
using NuGet.Versioning;

namespace NugetPackageManager.Core.Workspace.Tools;

/// <summary>What one tool version rewrite did.</summary>
public sealed record LocalToolManifestWriteResult
{
    /// <summary>The manifest that was written.</summary>
    public required string ManifestPath { get; init; }

    /// <summary>The package id whose version changed.</summary>
    public required string ToolId { get; init; }

    /// <summary>The version the manifest pinned before the write.</summary>
    public required string PreviousVersion { get; init; }

    /// <summary>The version the manifest pins now.</summary>
    public required string Version { get; init; }
}

/// <summary>
/// Changes exactly one tool's <c>"version"</c> string inside <c>.config/dotnet-tools.json</c>.
///
/// This is a targeted edit of the original bytes, mirroring <c>CpmWriter</c>: the file is not
/// re-serialized, so formatting, line endings, a byte-order mark, tool order and every field the
/// reader does not understand all survive untouched. Before the write the edited bytes are
/// verified — they parse, the addressed tool carries the new version, and every other value is
/// unchanged — and the file is replaced through a temporary file so a failure never leaves a
/// half-written manifest. A write is refused when the manifest no longer pins the version the
/// caller rendered its row from.
/// </summary>
public static class LocalToolManifestWriter
{
    private const string VersionMismatchCode = "versionMismatch";
    private const string ToolNotFoundCode = "toolNotFound";
    private const string InvalidManifestCode = "invalidManifest";
    private const string InvalidVersionCode = "invalidVersion";
    private const string FileChangedCode = "fileChanged";
    private const string VerificationFailedCode = "verificationFailed";

    private static readonly byte[] byteOrderMark = [0xEF, 0xBB, 0xBF];

    private static readonly SemaphoreSlim fileLock = new(1, 1);

    /// <summary>Pins one tool at <paramref name="version"/>.</summary>
    /// <param name="manifestPath">The <c>.config/dotnet-tools.json</c> to edit.</param>
    /// <param name="toolId">The package id to change (the key in the manifest's <c>tools</c> object).</param>
    /// <param name="expectedVersion">The version the caller believes is pinned; a mismatch refuses the write.</param>
    /// <param name="version">The version to write.</param>
    /// <param name="cancellationToken">Cancels the read, the verification and the write.</param>
    /// <exception cref="WorkspaceException">
    /// The manifest, tool or version is unusable (<c>manifestNotFound</c>, <c>toolNotFound</c>,
    /// <c>invalidManifest</c>, <c>invalidVersion</c>), someone else edited the file
    /// (<c>versionMismatch</c>, <c>fileChanged</c>), or the edit would not verify
    /// (<c>verificationFailed</c>). Nothing is written in any of those cases.
    /// </exception>
    public static async Task<LocalToolManifestWriteResult> UpdateVersionAsync(
        string manifestPath,
        string toolId,
        string expectedVersion,
        string version,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(toolId);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedVersion);
        ArgumentException.ThrowIfNullOrWhiteSpace(version);

        if (!NuGetVersion.TryParse(version, out _))
        {
            throw new WorkspaceException(InvalidVersionCode, $"'{version}' is not a valid NuGet version.");
        }

        await fileLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return await UpdateCoreAsync(manifestPath, toolId, expectedVersion, version, cancellationToken)
                .ConfigureAwait(false);
        }
        finally
        {
            fileLock.Release();
        }
    }

    private static async Task<LocalToolManifestWriteResult> UpdateCoreAsync(
        string manifestPath,
        string toolId,
        string expectedVersion,
        string version,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(manifestPath);
        if (!info.Exists)
        {
            throw new WorkspaceException("manifestNotFound", $"{manifestPath} does not exist.");
        }

        var stamp = info.LastWriteTimeUtc;
        var bytes = await File.ReadAllBytesAsync(info.FullName, cancellationToken).ConfigureAwait(false);
        var hasByteOrderMark = HasByteOrderMark(bytes);
        var json = hasByteOrderMark
            ? bytes[byteOrderMark.Length..]
            : bytes;

        EnsureValidJson(manifestPath, json);

        if (!TryLocateVersion(json, toolId, out var valueStart, out var valueEnd, out var currentVersion))
        {
            throw new WorkspaceException(
                ToolNotFoundCode,
                $"{manifestPath} does not declare a tool '{toolId}'.");
        }

        if (!string.Equals(currentVersion, expectedVersion, StringComparison.Ordinal))
        {
            throw new WorkspaceException(
                VersionMismatchCode,
                $"{manifestPath} pins '{toolId}' at {currentVersion ?? "(no version)"}, not at {expectedVersion}; " +
                "someone changed the manifest — reload the tool list and retry.");
        }

        if (!IsPlainJsonString(json, valueStart, valueEnd))
        {
            throw new WorkspaceException(
                InvalidManifestCode,
                $"{manifestPath} escapes the version of '{toolId}'; the manifest is not edited automatically.");
        }

        var replacement = Encoding.UTF8.GetBytes($"\"{version}\"");
        var updatedJson = Replace(json, valueStart, valueEnd, replacement);

        Verify(manifestPath, toolId, json, updatedJson, version);

        byte[] output;
        if (hasByteOrderMark)
        {
            output = [.. byteOrderMark, .. updatedJson];
        }
        else
        {
            output = updatedJson;
        }

        await WriteAsync(info.FullName, stamp, output, cancellationToken).ConfigureAwait(false);

        return new LocalToolManifestWriteResult
        {
            ManifestPath = info.FullName,
            ToolId = toolId,
            PreviousVersion = currentVersion ?? string.Empty,
            Version = version,
        };
    }

    /// <summary>
    /// The whole document must parse before anything is looked up in it. <see cref="TryLocateVersion"/>
    /// stops reading at the tool's <c>"version"</c> string, so a syntax error later in the file would
    /// otherwise slip past this check and only surface as a failed verification of the edit.
    /// </summary>
    private static void EnsureValidJson(string manifestPath, byte[] json)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
        }
        catch (JsonException exception)
        {
            throw new WorkspaceException(
                InvalidManifestCode,
                $"{manifestPath} is not valid JSON ({exception.Message}); the manifest is not edited automatically.",
                exception);
        }
    }

    /// <summary>The byte range of the tool's <c>"version"</c> string value, quotes included.</summary>
    private static bool TryLocateVersion(
        byte[] json,
        string toolId,
        out int valueStart,
        out int valueEnd,
        out string? currentVersion)
    {
        valueStart = 0;
        valueEnd = 0;
        currentVersion = null;

        try
        {
            return LocateVersion(json, toolId, ref valueStart, ref valueEnd, ref currentVersion);
        }
        catch (JsonException exception)
        {
            throw new WorkspaceException(
                InvalidManifestCode,
                $"The manifest is not valid JSON ({exception.Message}); it is not edited automatically.",
                exception);
        }
    }

    private static bool LocateVersion(
        byte[] json,
        string toolId,
        ref int valueStart,
        ref int valueEnd,
        ref string? currentVersion)
    {
        var reader = new Utf8JsonReader(json);
        var containers = new List<string?>();
        string? pendingName = null;

        while (reader.Read())
        {
            var tokenType = reader.TokenType;

            if (tokenType == JsonTokenType.PropertyName)
            {
                pendingName = reader.GetString();
                continue;
            }

            if (TryReadContainerToken(tokenType, containers, ref pendingName))
            {
                continue;
            }

            if (tokenType == JsonTokenType.String && IsToolVersion(containers, pendingName, toolId))
            {
                valueStart = (int)reader.TokenStartIndex;
                valueEnd = (int)reader.BytesConsumed;
                currentVersion = reader.GetString();
                return true;
            }

            pendingName = null;
        }

        return false;
    }

    /// <summary>
    /// Pushes or pops the container stack for a structure token, clearing the pending property
    /// name either way. False for every other token, which the caller then inspects itself.
    /// </summary>
    private static bool TryReadContainerToken(
        JsonTokenType tokenType,
        List<string?> containers,
        ref string? pendingName)
    {
        if (tokenType is JsonTokenType.StartObject or JsonTokenType.StartArray)
        {
            containers.Add(tokenType == JsonTokenType.StartObject ? pendingName : null);
            pendingName = null;
            return true;
        }

        if (tokenType is JsonTokenType.EndObject or JsonTokenType.EndArray)
        {
            PopContainer(containers);
            pendingName = null;
            return true;
        }

        return false;
    }

    private static void PopContainer(List<string?> containers)
    {
        if (containers.Count > 0)
        {
            containers.RemoveAt(containers.Count - 1);
        }
    }

    /// <summary>
    /// True when the current container stack is root → <c>tools</c> → this tool, so the property
    /// is that tool's own <c>version</c> and not one of an object nested inside it.
    /// </summary>
    private static bool IsToolVersion(List<string?> containers, string? propertyName, string toolId) =>
        containers.Count == 3
        && string.Equals(containers[1], "tools", StringComparison.Ordinal)
        && string.Equals(containers[2], toolId, StringComparison.Ordinal)
        && string.Equals(propertyName, "version", StringComparison.Ordinal);

    /// <summary>True when the located token is <c>"text"</c> with no escape sequences.</summary>
    private static bool IsPlainJsonString(byte[] json, int start, int end)
    {
        if (end - start < 2 || json[start] != (byte)'"' || json[end - 1] != (byte)'"')
        {
            return false;
        }

        for (var index = start; index < end; index++)
        {
            if (json[index] == (byte)'\\')
            {
                return false;
            }
        }

        return true;
    }

    private static byte[] Replace(byte[] json, int start, int end, byte[] replacement)
    {
        var updated = new byte[json.Length - (end - start) + replacement.Length];
        json.AsSpan(0, start).CopyTo(updated);
        replacement.CopyTo(updated.AsSpan(start));
        json.AsSpan(end).CopyTo(updated.AsSpan(start + replacement.Length));
        return updated;
    }

    /// <summary>
    /// The edited bytes must parse, must carry the new version, and must be identical to the
    /// original everywhere else — including fields this project does not model.
    /// </summary>
    private static void Verify(string manifestPath, string toolId, byte[] original, byte[] updated, string version)
    {
        using var originalDocument = ParseOrThrow(original, manifestPath);
        using var updatedDocument = ParseOrThrow(updated, manifestPath);

        var written = updatedDocument.RootElement;
        if (!written.TryGetProperty("tools", out var tools)
            || tools.ValueKind != JsonValueKind.Object
            || !tools.TryGetProperty(toolId, out var tool)
            || tool.ValueKind != JsonValueKind.Object
            || !tool.TryGetProperty("version", out var writtenVersion)
            || writtenVersion.ValueKind != JsonValueKind.String
            || !string.Equals(writtenVersion.GetString(), version, StringComparison.Ordinal))
        {
            throw new WorkspaceException(
                VerificationFailedCode,
                $"{manifestPath} would not pin '{toolId}' at {version} after the edit; the manifest was not written.");
        }

        Compare(originalDocument.RootElement, updatedDocument.RootElement, string.Empty, toolId, version, manifestPath);
    }

    private static JsonDocument ParseOrThrow(byte[] json, string manifestPath)
    {
        try
        {
            return JsonDocument.Parse(json);
        }
        catch (JsonException exception)
        {
            throw new WorkspaceException(
                VerificationFailedCode,
                $"{manifestPath} would not be valid JSON after the edit ({exception.Message}); " +
                "the manifest was not written.",
                exception);
        }
    }

    private static void Compare(
        JsonElement original,
        JsonElement updated,
        string path,
        string toolId,
        string version,
        string manifestPath)
    {
        if (original.ValueKind != updated.ValueKind)
        {
            throw Changed(path, manifestPath);
        }

        if (original.ValueKind == JsonValueKind.Object)
        {
            CompareObject(original, updated, path, toolId, version, manifestPath);
            return;
        }

        if (original.ValueKind == JsonValueKind.Array)
        {
            CompareArray(original, updated, path, toolId, version, manifestPath);
            return;
        }

        if (!string.Equals(original.GetRawText(), updated.GetRawText(), StringComparison.Ordinal))
        {
            throw Changed(path, manifestPath);
        }
    }

    private static void CompareObject(
        JsonElement original,
        JsonElement updated,
        string path,
        string toolId,
        string version,
        string manifestPath)
    {
        var originalProperties = original.EnumerateObject().ToList();
        var updatedProperties = updated.EnumerateObject().ToList();

        if (originalProperties.Count != updatedProperties.Count)
        {
            throw Changed(path, manifestPath);
        }

        for (var index = 0; index < originalProperties.Count; index++)
        {
            var before = originalProperties[index];
            var after = updatedProperties[index];

            if (!string.Equals(before.Name, after.Name, StringComparison.Ordinal))
            {
                throw Changed(path, manifestPath);
            }

            var childPath = $"{path}/{before.Name}";
            if (IsTargetVersion(childPath, toolId))
            {
                AssertTargetVersion(after.Value, version, childPath, manifestPath);
                continue;
            }

            Compare(before.Value, after.Value, childPath, toolId, version, manifestPath);
        }
    }

    private static void CompareArray(
        JsonElement original,
        JsonElement updated,
        string path,
        string toolId,
        string version,
        string manifestPath)
    {
        var originalItems = original.EnumerateArray().ToList();
        var updatedItems = updated.EnumerateArray().ToList();

        if (originalItems.Count != updatedItems.Count)
        {
            throw Changed(path, manifestPath);
        }

        for (var index = 0; index < originalItems.Count; index++)
        {
            Compare(
                originalItems[index],
                updatedItems[index],
                $"{path}[{index.ToString(CultureInfo.InvariantCulture)}]",
                toolId,
                version,
                manifestPath);
        }
    }

    /// <summary>True for the one path the edit is allowed to change: the tool's pinned version.</summary>
    private static bool IsTargetVersion(string path, string toolId) =>
        string.Equals(path, $"/tools/{toolId}/version", StringComparison.Ordinal);

    private static void AssertTargetVersion(
        JsonElement value,
        string version,
        string path,
        string manifestPath)
    {
        if (value.ValueKind != JsonValueKind.String
            || !string.Equals(value.GetString(), version, StringComparison.Ordinal))
        {
            throw Changed(path, manifestPath);
        }
    }

    private static WorkspaceException Changed(string path, string manifestPath) =>
        new(
            VerificationFailedCode,
            $"{manifestPath}: the edit changed '{path}', which it must leave untouched; " +
            "the manifest was not written.");

    private static bool HasByteOrderMark(byte[] bytes) =>
        bytes.Length >= 3
        && bytes[0] == byteOrderMark[0]
        && bytes[1] == byteOrderMark[1]
        && bytes[2] == byteOrderMark[2];

    /// <summary>
    /// Refuses to overwrite a file that changed while the edit was prepared, then replaces it
    /// through a temporary file in the same directory so the swap is atomic.
    /// </summary>
    private static async Task WriteAsync(
        string path,
        DateTime expectedStamp,
        byte[] content,
        CancellationToken cancellationToken)
    {
        var info = new FileInfo(path);
        info.Refresh();

        if (info.LastWriteTimeUtc != expectedStamp)
        {
            throw new WorkspaceException(
                FileChangedCode,
                $"{path} changed while the update was being prepared; reload the tool list and retry.");
        }

        var tempPath = path + "." + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ".tmp";
        try
        {
            await File.WriteAllBytesAsync(tempPath, content, cancellationToken).ConfigureAwait(false);
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
}
