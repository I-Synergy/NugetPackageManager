using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace NugetPackageManager.Core.Toolchain;

/// <summary>
/// Reads and writes the SDK pin in <c>global.json</c> — the file <c>dotnet</c> itself reads.
///
/// A pin is only coherent if the rest of the file agrees with it, so the update also sets
/// <c>sdk.allowPrerelease</c> for a prerelease version, drops <c>sdk.workloadVersion</c> when it
/// pins a workload set for another feature band, and keeps <c>tools.dotnet</c> in step. The edit
/// is surgical when possible so comments, key order and unrelated sections survive; the result
/// is parsed back before it is written, and a patch that does not verify falls back to a
/// canonical rewrite.
/// </summary>
public static partial class GlobalJson
{
    private const int MaxWalkDepth = 32;

    private const string RollForwardProperty = "rollForward";
    private const string AllowPrereleaseProperty = "allowPrerelease";
    private const string ToolsProperty = "tools";
    private const string RollForwardDisabled = "disable";
    private const string WorkloadVersionProperty = "workloadVersion";
    private const string DotnetToolProperty = "dotnet";

    /// <summary>Upper bound for the pattern-based property edits; the slices are small.</summary>
    private static readonly TimeSpan regexTimeout = TimeSpan.FromSeconds(2);

    public static bool IsValidSdkVersion(string version) =>
        SdkVersion().IsMatch(version.Trim());

    /// <summary>
    /// Feature band of an SDK or workload-set version: <c>10.0.403</c> and <c>10.0.401.1</c>
    /// both belong to <c>10.0.400</c>; <c>11.0.100-rc.3...</c> belongs to <c>11.0.100</c>.
    /// </summary>
    public static string FeatureBand(string version)
    {
        var numeric = version.Trim().Split('-')[0];
        var parts = numeric.Split('.');
        var major = parts.Length > 0 ? parts[0] : string.Empty;
        var minor = parts.Length > 1 ? parts[1] : string.Empty;
        var patchText = parts.Length > 2 ? parts[2] : "0";
        var band = int.TryParse(patchText, out var patch) ? patch - (patch % 100) : 0;
        return $"{major}.{minor}.{band}";
    }

    /// <summary>Parses the <c>sdk</c> section. Returns null when the file is unreadable.</summary>
    public static GlobalJsonSettings? Parse(string content)
    {
        var parsed = TryParseObject(content);
        if (parsed?["sdk"] is not JsonObject sdk)
        {
            return null;
        }

        return new GlobalJsonSettings(
            ReadString(sdk, "version"),
            ReadString(sdk, RollForwardProperty),
            sdk[AllowPrereleaseProperty] is JsonValue allow && allow.TryGetValue<bool>(out var flag)
                ? flag
                : null);
    }

    /// <summary>Nearest <c>global.json</c> at or above <paramref name="startDirectory"/>.</summary>
    public static string? FindUpwards(string startDirectory)
    {
        var current = Path.GetFullPath(startDirectory);

        for (var depth = 0; depth < MaxWalkDepth; depth++)
        {
            var candidate = Path.Combine(current, "global.json");
            if (File.Exists(candidate))
            {
                return candidate;
            }

            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent) || parent == current)
            {
                return null;
            }

            current = parent;
        }

        return null;
    }

    /// <summary>
    /// Pins <paramref name="version"/> in the nearest <c>global.json</c>, creating one under
    /// <paramref name="startDirectory"/> when the workspace has none.
    /// </summary>
    public static GlobalJsonUpdateResult UpdateFile(string startDirectory, string version)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(startDirectory);

        var trimmed = version.Trim();
        if (!IsValidSdkVersion(trimmed))
        {
            throw new ArgumentException($"\"{trimmed}\" is not a valid .NET SDK version.", nameof(version));
        }

        var resolvedStart = Path.GetFullPath(startDirectory);
        var existing = FindUpwards(resolvedStart);
        var globalJsonPath = existing ?? Path.Combine(resolvedStart, "global.json");
        var original = existing is null ? string.Empty : File.ReadAllText(globalJsonPath);
        var previousVersion = Parse(original)?.Version;

        var sdkRange = FindObjectRange(original, "sdk");
        var toolsRange = FindObjectRange(original, ToolsProperty);
        var plan = PlanCoherence(
            sdkRange is null ? null : original[sdkRange.Value.Start..sdkRange.Value.End],
            toolsRange is null ? null : original[toolsRange.Value.Start..toolsRange.Value.End],
            trimmed);

        var patched = original.Length > 0 ? ApplyPlan(original, plan, trimmed) : string.Empty;
        var content = patched.Length > 0 && IsCoherent(patched, trimmed, plan)
            ? patched
            : CanonicalJson(original, trimmed, plan);

        if (!File.Exists(globalJsonPath) || content != original)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(globalJsonPath) ?? resolvedStart);
            File.WriteAllText(globalJsonPath, content, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }

        var changed = previousVersion != trimmed
            || plan.SetAllowPrerelease
            || plan.SetRollForward is not null
            || plan.RemoveWorkloadVersion is not null
            || plan.UpdateToolsDotnet is not null;

        return new GlobalJsonUpdateResult
        {
            GlobalJsonPath = globalJsonPath,
            Created = existing is null,
            Changed = changed,
            PreviousVersion = previousVersion,
            Notes = plan.Notes,
        };
    }

    private static CoherencePlan PlanCoherence(string? sdkSlice, string? toolsSlice, string version)
    {
        var plan = new CoherencePlan();

        if (sdkSlice is not null)
        {
            PlanAllowPrerelease(sdkSlice, version, plan);
            PlanRollForward(sdkSlice, plan);
            PlanWorkloadVersion(sdkSlice, version, plan);
        }

        if (toolsSlice is not null)
        {
            PlanToolsCoherence(toolsSlice, version, plan);
        }

        return plan;
    }

    private static void PlanAllowPrerelease(string sdkSlice, string version, CoherencePlan plan)
    {
        var allowPrerelease = ReadBooleanProperty(sdkSlice, AllowPrereleaseProperty);
        if (!version.Contains('-') || allowPrerelease != false)
        {
            return;
        }

        plan.SetAllowPrerelease = true;
        plan.Notes.Add("sdk.allowPrerelease set to true for a prerelease SDK");
    }

    private static void PlanRollForward(string sdkSlice, CoherencePlan plan)
    {
        // A pin selects one exact SDK: rolling forward would silently use a different one than
        // the selector shows.
        var rollForward = ReadStringProperty(sdkSlice, RollForwardProperty);
        if (rollForward == RollForwardDisabled)
        {
            return;
        }

        plan.SetRollForward = rollForward ?? "(unset)";
        plan.Notes.Add(rollForward is null
            ? "sdk.rollForward set to disable"
            : $"sdk.rollForward set to disable (was {rollForward})");
    }

    private static void PlanWorkloadVersion(string sdkSlice, string version, CoherencePlan plan)
    {
        var workloadVersion = ReadStringProperty(sdkSlice, WorkloadVersionProperty);
        if (workloadVersion is null || FeatureBand(workloadVersion) == FeatureBand(version))
        {
            return;
        }

        plan.RemoveWorkloadVersion = workloadVersion;
        plan.Notes.Add(
            $"removed sdk.workloadVersion {workloadVersion} (band {FeatureBand(workloadVersion)}; the selected SDK is {FeatureBand(version)})");
    }

    private static void PlanToolsCoherence(string toolsSlice, string version, CoherencePlan plan)
    {
        var toolsDotnet = ReadStringProperty(toolsSlice, DotnetToolProperty);
        if (toolsDotnet is null || toolsDotnet == version)
        {
            return;
        }

        plan.UpdateToolsDotnet = toolsDotnet;
        plan.Notes.Add($"tools.dotnet updated from {toolsDotnet} to {version}");
    }

    private static string ApplyPlan(string text, CoherencePlan plan, string version)
    {
        var result = text;

        var sdkRange = FindObjectRange(result, "sdk");
        if (sdkRange is { } sdkObject)
        {
            var sdkSlice = result[sdkObject.Start..sdkObject.End];
            sdkSlice = HasStringProperty(sdkSlice, "version")
                ? ReplaceStringProperty(sdkSlice, "version", version)
                : sdkSlice.Replace("{", $"{{\n    \"version\": \"{version}\",", StringComparison.Ordinal);
            if (plan.SetRollForward is not null)
            {
                sdkSlice = HasStringProperty(sdkSlice, RollForwardProperty)
                    ? ReplaceStringProperty(sdkSlice, RollForwardProperty, RollForwardDisabled)
                    : InsertStringPropertyAfter(sdkSlice, "version", RollForwardProperty, RollForwardDisabled);
            }

            if (plan.SetAllowPrerelease)
            {
                sdkSlice = SetBooleanProperty(sdkSlice, AllowPrereleaseProperty, value: true);
            }

            if (plan.RemoveWorkloadVersion is not null)
            {
                sdkSlice = RemoveStringProperty(sdkSlice, WorkloadVersionProperty);
            }

            result = result[..sdkObject.Start] + sdkSlice + result[sdkObject.End..];
        }

        var toolsRange = FindObjectRange(result, ToolsProperty);
        if (toolsRange is { } toolsObject && plan.UpdateToolsDotnet is not null)
        {
            var toolsSlice = result[toolsObject.Start..toolsObject.End];
            var updated = ReplaceStringProperty(toolsSlice, DotnetToolProperty, version);
            result = result[..toolsObject.Start] + updated + result[toolsObject.End..];
        }

        return result;
    }

    private static string CanonicalJson(string original, string version, CoherencePlan plan)
    {
        var parsed = TryParseObject(original) ?? [];

        var sdk = parsed["sdk"] is JsonObject existingSdk
            ? (JsonObject)existingSdk.DeepClone()
            : [];
        sdk["version"] = version;
        if (plan.SetRollForward is not null || sdk[RollForwardProperty] is null)
        {
            sdk[RollForwardProperty] = RollForwardDisabled;
        }

        if (plan.SetAllowPrerelease)
        {
            sdk[AllowPrereleaseProperty] = true;
        }

        if (plan.RemoveWorkloadVersion is not null)
        {
            sdk.Remove(WorkloadVersionProperty);
        }

        parsed["sdk"] = sdk;

        if (plan.UpdateToolsDotnet is not null && parsed[ToolsProperty] is JsonObject tools)
        {
            tools[DotnetToolProperty] = version;
        }

        return parsed.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n";
    }

    /// <summary>True when the written text pins <paramref name="version"/> and honours the plan.</summary>
    private static bool IsCoherent(string content, string version, CoherencePlan plan)
    {
        var parsed = TryParseObject(content);
        if (parsed?["sdk"] is not JsonObject sdk || ReadString(sdk, "version") != version)
        {
            return false;
        }

        if (ReadString(sdk, RollForwardProperty) != RollForwardDisabled)
        {
            return false;
        }

        if (plan.SetAllowPrerelease
            && !(sdk[AllowPrereleaseProperty] is JsonValue allow && allow.TryGetValue<bool>(out var flag) && flag))
        {
            return false;
        }

        if (plan.RemoveWorkloadVersion is not null && sdk.ContainsKey(WorkloadVersionProperty))
        {
            return false;
        }

        return plan.UpdateToolsDotnet is null
            || (parsed[ToolsProperty] is JsonObject tools && ReadString(tools, DotnetToolProperty) == version);
    }

    private static JsonObject? TryParseObject(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return null;
        }

        try
        {
            var text = StripJsonCommentsAndTrailingCommas(content.TrimStart('\uFEFF'));
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Removes <c>//</c> and block comments and trailing commas so a file written for the SDK's
    /// tolerant JSON reader parses with <see cref="JsonNode"/>. String contents are preserved.
    /// </summary>
    public static string StripJsonCommentsAndTrailingCommas(string text) =>
        TrailingComma().Replace(RemoveComments(text), "$1");

    private static string RemoveComments(string text)
    {
        var result = new StringBuilder(text.Length);
        var index = 0;

        while (index < text.Length)
        {
            var character = text[index];
            if (character == '"')
            {
                var end = ScanString(text, index);
                result.Append(text, index, end - index);
                index = end;
                continue;
            }

            if (character == '/' && index + 1 < text.Length && text[index + 1] == '/')
            {
                index = SkipLineComment(text, index) + 1;
                result.Append('\n');
                continue;
            }

            if (character == '/' && index + 1 < text.Length && text[index + 1] == '*')
            {
                index = SkipBlockComment(text, index);
                continue;
            }

            result.Append(character);
            index++;
        }

        return result.ToString();
    }

    private static int ScanString(string text, int start)
    {
        var index = start + 1;
        while (index < text.Length)
        {
            var character = text[index];
            if (character == '\\')
            {
                index += 2;
                continue;
            }

            index++;
            if (character == '"')
            {
                return index;
            }
        }

        return text.Length;
    }

    private static int SkipLineComment(string text, int start)
    {
        var index = start;
        while (index < text.Length && text[index] != '\n')
        {
            index++;
        }

        return index;
    }

    private static int SkipBlockComment(string text, int start)
    {
        var index = start + 2;
        while (index < text.Length && !(text[index] == '*' && text[index + 1] == '/'))
        {
            index++;
        }

        return index + 2;
    }

    /// <summary>Range of the <c>{...}</c> object that follows <c>"key"</c>, string-aware.</summary>
    private static (int Start, int End)? FindObjectRange(string text, string key)
    {
        var keyIndex = text.IndexOf($"\"{key}\"", StringComparison.Ordinal);
        if (keyIndex < 0)
        {
            return null;
        }

        var start = text.IndexOf('{', keyIndex);
        if (start < 0)
        {
            return null;
        }

        var end = ScanObjectEnd(text, start);
        return end is null ? null : (start, end.Value);
    }

    private static int? ScanObjectEnd(string text, int start)
    {
        var depth = 0;
        var inString = false;
        var escaped = false;

        for (var index = start; index < text.Length; index++)
        {
            var character = text[index];
            if (inString)
            {
                if (escaped)
                {
                    escaped = false;
                }
                else if (character == '\\')
                {
                    escaped = true;
                }
                else if (character == '"')
                {
                    inString = false;
                }

                continue;
            }

            if (character == '"')
            {
                inString = true;
            }
            else if (character == '{')
            {
                depth++;
            }
            else if (character == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return index + 1;
                }
            }
        }

        return null;
    }

    private static string ReplaceStringProperty(string slice, string key, string value) =>
        Regex.Replace(
            slice,
            $"(\"{Regex.Escape(key)}\"\\s*:\\s*\")[^\"]*(\")",
            $"$1{value}$2",
            RegexOptions.None,
            regexTimeout);

    private static bool? ReadBooleanProperty(string slice, string key)
    {
        var match = Regex.Match(
            slice,
            $"\"{Regex.Escape(key)}\"\\s*:\\s*(true|false)",
            RegexOptions.None,
            regexTimeout);
        return match.Success ? match.Groups[1].Value == "true" : null;
    }

    private static string SetBooleanProperty(string slice, string key, bool value) =>
        Regex.Replace(
            slice,
            $"(\"{Regex.Escape(key)}\"\\s*:\\s*)(true|false)",
            $"$1{(value ? "true" : "false")}",
            RegexOptions.None,
            regexTimeout);

    private static bool HasStringProperty(string slice, string key) =>
        Regex.IsMatch(
            slice,
            $"\"{Regex.Escape(key)}\"\\s*:\\s*\"",
            RegexOptions.None,
            regexTimeout);

    private static string? ReadStringProperty(string slice, string key)
    {
        var match = Regex.Match(
            slice,
            $"\"{Regex.Escape(key)}\"\\s*:\\s*\"([^\"]*)\"",
            RegexOptions.None,
            regexTimeout);
        return match.Success ? match.Groups[1].Value : null;
    }

    private static string InsertStringPropertyAfter(
        string slice,
        string afterKey,
        string key,
        string value) =>
        Regex.Replace(
            slice,
            $"(\"{Regex.Escape(afterKey)}\"\\s*:\\s*\"[^\"]*\")",
            $"$1,\n    \"{key}\": \"{value}\"",
            RegexOptions.None,
            regexTimeout);

    private static string RemoveStringProperty(string slice, string key)
    {
        var trailingPattern = $"\\s*\"{Regex.Escape(key)}\"\\s*:\\s*\"[^\"]*\"\\s*,";
        var result = Regex.IsMatch(slice, trailingPattern, RegexOptions.None, regexTimeout)
            ? Regex.Replace(slice, trailingPattern, string.Empty, RegexOptions.None, regexTimeout)
            : Regex.Replace(
                slice,
                $",\\s*\"{Regex.Escape(key)}\"\\s*:\\s*\"[^\"]*\"",
                string.Empty,
                RegexOptions.None,
                regexTimeout);

        return TrailingCommaBeforeBrace().Replace(result, "}");
    }

    private static string? ReadString(JsonObject obj, string property) =>
        obj[property] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private sealed class CoherencePlan
    {
        public bool SetAllowPrerelease { get; set; }

        /// <summary>Previous <c>sdk.rollForward</c>; only its presence matters.</summary>
        public string? SetRollForward { get; set; }

        public string? RemoveWorkloadVersion { get; set; }

        public string? UpdateToolsDotnet { get; set; }

        public List<string> Notes { get; } = [];
    }

    [GeneratedRegex(@"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$", RegexOptions.CultureInvariant)]
    private static partial Regex SdkVersion();

    [GeneratedRegex(@",(\s*[}\]])", RegexOptions.CultureInvariant)]
    private static partial Regex TrailingComma();

    [GeneratedRegex(@",\s*}", RegexOptions.CultureInvariant)]
    private static partial Regex TrailingCommaBeforeBrace();
}
