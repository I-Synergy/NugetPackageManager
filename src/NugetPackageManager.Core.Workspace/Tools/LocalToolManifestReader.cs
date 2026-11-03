using System.Text;
using System.Text.Json;

namespace NugetPackageManager.Core.Workspace.Tools;

/// <summary>
/// Parses <c>.config/dotnet-tools.json</c> (<c>{ version, isRoot, tools: { id: { version,
/// commands, rollForward } } }</c>) into <see cref="LocalToolManifestDocument"/>.
///
/// Reading never throws for a malformed manifest: what is wrong with the file is part of the
/// answer, because the health card reports it. The raw text and the byte-order-mark flag are
/// carried along so <see cref="LocalToolManifestWriter"/> can edit the original bytes.
/// </summary>
public static class LocalToolManifestReader
{
    /// <summary>The only manifest schema version .NET has shipped.</summary>
    public const string SupportedSchemaVersion = "1";

    private static readonly byte[] byteOrderMark = [0xEF, 0xBB, 0xBF];

    /// <summary>Reads and parses one manifest.</summary>
    /// <param name="manifestPath">The manifest to read.</param>
    /// <param name="cancellationToken">Cancels the read.</param>
    public static async Task<LocalToolManifestDocument> ReadAsync(
        string manifestPath,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestPath);

        var bytes = await File.ReadAllBytesAsync(manifestPath, cancellationToken).ConfigureAwait(false);
        var hasByteOrderMark = HasByteOrderMarkPrefix(bytes);
        var offset = hasByteOrderMark ? byteOrderMark.Length : 0;
        var text = Encoding.UTF8.GetString(bytes, offset, bytes.Length - offset);

        return Parse(Path.GetFullPath(manifestPath), text, hasByteOrderMark);
    }

    /// <summary>Parses manifest text the caller already has (a fixture, or the text just written).</summary>
    /// <param name="manifestPath">The path the text came from, used for the document and its problems.</param>
    /// <param name="text">The manifest text, without a byte-order mark.</param>
    /// <param name="hasByteOrderMark">Whether the source file starts with a UTF-8 byte-order mark.</param>
    public static LocalToolManifestDocument Parse(
        string manifestPath,
        string text,
        bool hasByteOrderMark = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(manifestPath);
        ArgumentNullException.ThrowIfNull(text);

        var problems = new List<string>();
        var tools = new List<LocalToolDefinition>();
        string? version = null;
        var isRoot = false;

        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;

            if (root.ValueKind != JsonValueKind.Object)
            {
                problems.Add("The manifest root is not a JSON object.");
            }
            else
            {
                version = ReadScalar(root, "version");
                if (version is null)
                {
                    problems.Add("The manifest has no `version`.");
                }
                else if (version != SupportedSchemaVersion)
                {
                    problems.Add(
                        $"The manifest declares version '{version}'; only version {SupportedSchemaVersion} is understood.");
                }

                isRoot = root.TryGetProperty("isRoot", out var isRootElement)
                    && isRootElement.ValueKind == JsonValueKind.True;

                ReadTools(root, tools, problems);
            }
        }
        catch (JsonException exception)
        {
            problems.Add($"The manifest is not valid JSON: {exception.Message}");

            return new LocalToolManifestDocument
            {
                Path = manifestPath,
                Version = null,
                IsRoot = false,
                Tools = [],
                Problems = problems,
                Parsed = false,
                Text = text,
                HasByteOrderMark = hasByteOrderMark,
            };
        }

        return new LocalToolManifestDocument
        {
            Path = manifestPath,
            Version = version,
            IsRoot = isRoot,
            Tools = tools,
            Problems = problems,
            Parsed = true,
            Text = text,
            HasByteOrderMark = hasByteOrderMark,
        };
    }

    /// <summary>The UTF-8 byte-order-mark bytes a rewrite must preserve.</summary>
    public static ReadOnlySpan<byte> Utf8ByteOrderMark => byteOrderMark;

    private static void ReadTools(
        JsonElement root,
        List<LocalToolDefinition> tools,
        List<string> problems)
    {
        if (!root.TryGetProperty("tools", out var toolsElement))
        {
            problems.Add("The manifest has no `tools` object.");
            return;
        }

        if (toolsElement.ValueKind != JsonValueKind.Object)
        {
            problems.Add("The manifest's `tools` property is not an object.");
            return;
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var commands = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var entry in toolsElement.EnumerateObject())
        {
            ReadTool(entry, ids, commands, tools, problems);
        }
    }

    /// <summary>Reads one <c>tools</c> entry, recording what is wrong with it as a problem.</summary>
    private static void ReadTool(
        JsonProperty entry,
        HashSet<string> ids,
        Dictionary<string, string> commands,
        List<LocalToolDefinition> tools,
        List<string> problems)
    {
        var id = entry.Name;

        if (string.IsNullOrWhiteSpace(id))
        {
            problems.Add("The manifest declares a tool with an empty id.");
            return;
        }

        if (!ids.Add(id))
        {
            problems.Add($"The manifest declares tool '{id}' more than once.");
            return;
        }

        if (entry.Value.ValueKind != JsonValueKind.Object)
        {
            problems.Add($"Tool '{id}' is not a JSON object.");
            return;
        }

        var version = ReadScalar(entry.Value, "version");
        if (string.IsNullOrWhiteSpace(version))
        {
            problems.Add($"Tool '{id}' has no `version`.");
            version = string.Empty;
        }

        var toolCommands = ReadCommands(id, entry.Value, problems);
        RecordCommands(id, toolCommands, commands, problems);

        tools.Add(new LocalToolDefinition
        {
            Id = id,
            Version = version,
            Commands = toolCommands,
            RollForward = ReadRollForward(id, entry.Value, problems),
        });
    }

    /// <summary>Claims each command name for <paramref name="id"/>, reporting clashes in order.</summary>
    private static void RecordCommands(
        string id,
        List<string> toolCommands,
        Dictionary<string, string> commands,
        List<string> problems)
    {
        foreach (var command in toolCommands)
        {
            if (commands.TryGetValue(command, out var owner))
            {
                problems.Add(owner == id
                    ? $"Tool '{id}' declares command '{command}' more than once."
                    : $"Command '{command}' is declared by both '{owner}' and '{id}'.");
                continue;
            }

            commands[command] = id;
        }
    }

    private static List<string> ReadCommands(string id, JsonElement tool, List<string> problems)
    {
        if (!tool.TryGetProperty("commands", out var commands)
            || commands.ValueKind != JsonValueKind.Array)
        {
            problems.Add($"Tool '{id}' has no `commands` array.");
            return [];
        }

        var values = new List<string>();
        foreach (var element in commands.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.String)
            {
                problems.Add($"Tool '{id}' declares a command that is not a string.");
                continue;
            }

            var value = element.GetString();
            if (string.IsNullOrWhiteSpace(value))
            {
                problems.Add($"Tool '{id}' declares an empty command name.");
                continue;
            }

            values.Add(value);
        }

        if (values.Count == 0)
        {
            problems.Add($"Tool '{id}' declares no usable command name.");
        }

        return values;
    }

    private static bool? ReadRollForward(string id, JsonElement tool, List<string> problems)
    {
        if (!tool.TryGetProperty("rollForward", out var rollForward))
        {
            return null;
        }

        if (rollForward.ValueKind == JsonValueKind.True)
        {
            return true;
        }

        if (rollForward.ValueKind == JsonValueKind.False)
        {
            return false;
        }

        return ReportBadRollForward(id, problems);
    }

    private static bool? ReportBadRollForward(string id, List<string> problems)
    {
        problems.Add($"Tool '{id}' has a `rollForward` that is not true or false.");
        return null;
    }

    /// <summary>A scalar (string or number) property rendered as text; null when absent.</summary>
    private static string? ReadScalar(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString();
        }

        if (value.ValueKind == JsonValueKind.Number)
        {
            return value.GetRawText();
        }

        if (value.ValueKind == JsonValueKind.True)
        {
            return "true";
        }

        if (value.ValueKind == JsonValueKind.False)
        {
            return "false";
        }

        return null;
    }

    private static bool HasByteOrderMarkPrefix(byte[] bytes) =>
        bytes.Length >= 3
        && bytes[0] == byteOrderMark[0]
        && bytes[1] == byteOrderMark[1]
        && bytes[2] == byteOrderMark[2];
}
