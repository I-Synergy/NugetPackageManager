using System.Text.Json;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>
/// Reads the optional <c>localTools</c> slice of an <c>evaluateToolchain</c> request into
/// <see cref="LocalToolProbe"/> values.
///
/// The host already read the manifests for the tool card, so it hands the same facts to the
/// health probe instead of the evaluator reading the filesystem again. The slice is optional:
/// an older caller, or a probe that did not look, simply produces no local tool findings.
/// </summary>
public static class LocalToolProbeReader
{
    /// <summary>
    /// The probes in the request. Returns an empty list when the property is absent, present but
    /// not an array, or carries no usable manifest path.
    /// </summary>
    /// <param name="parameters">The <c>evaluateToolchain</c> parameters.</param>
    public static IReadOnlyList<LocalToolProbe> Read(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty("localTools", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var probes = new List<LocalToolProbe>();

        foreach (var element in array.EnumerateArray())
        {
            var manifestPath = ReadString(element, "manifestPath");
            if (string.IsNullOrWhiteSpace(manifestPath))
            {
                continue;
            }

            probes.Add(new LocalToolProbe
            {
                ManifestPath = manifestPath,
                Problems = ReadStringArray(element, "problems"),
                Tools = ReadTools(element),
            });
        }

        return probes;
    }

    private static List<LocalToolProbeTool> ReadTools(JsonElement element)
    {
        var tools = new List<LocalToolProbeTool>();

        if (element.ValueKind != JsonValueKind.Object
            || !element.TryGetProperty("tools", out var array)
            || array.ValueKind != JsonValueKind.Array)
        {
            return tools;
        }

        foreach (var tool in array.EnumerateArray())
        {
            var id = ReadString(tool, "id");
            if (string.IsNullOrWhiteSpace(id))
            {
                continue;
            }

            tools.Add(new LocalToolProbeTool
            {
                Id = id,
                Version = ReadString(tool, "version") ?? string.Empty,
                Restored = ReadNullableBoolean(tool, "restored"),
            });
        }

        return tools;
    }

    private static List<string> ReadStringArray(JsonElement element, string property)
    {
        var values = new List<string>();

        if (element.ValueKind == JsonValueKind.Object
            && element.TryGetProperty(property, out var array)
            && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in array.EnumerateArray())
            {
                if (entry.ValueKind == JsonValueKind.String && entry.GetString() is { Length: > 0 } value)
                {
                    values.Add(value);
                }
            }
        }

        return values;
    }

    private static string? ReadString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static bool? ReadNullableBoolean(JsonElement element, string property)
    {
        if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(property, out var value))
        {
            return null;
        }

        return value.ValueKind is JsonValueKind.True or JsonValueKind.False ? value.GetBoolean() : null;
    }
}
