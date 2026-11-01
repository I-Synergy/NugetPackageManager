using System.Text.Json;
using NugetPackageManager.Core.Protocol;
using NugetPackageManager.Core.Toolchain;

namespace NugetPackageManager.Core;

/// <summary>
/// Toolchain detection the host drives: the host spawns every <c>dotnet</c> command (progress,
/// cancellation, private install) and the core turns the captured output into findings and edits
/// <c>global.json</c>.
/// </summary>
public static class ToolchainHandlers
{
    public static Dictionary<string, RpcHandler> Create() =>
        new(StringComparer.Ordinal)
        {
            ["updateGlobalJsonSdkVersion"] = HandleUpdateGlobalJsonAsync,
            ["evaluateToolchain"] = HandleEvaluateToolchainAsync,
        };

    private static Task<object?> HandleUpdateGlobalJsonAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        var startDirectory = ReadRequiredString(parameters, "startDirectory");
        var version = ReadRequiredString(parameters, "version");

        try
        {
            return Task.FromResult<object?>(GlobalJson.UpdateFile(startDirectory, version));
        }
        catch (ArgumentException exception)
        {
            throw new RpcException(RpcException.InvalidParams, exception.Message);
        }
    }

    private static Task<object?> HandleEvaluateToolchainAsync(
        JsonElement parameters,
        CancellationToken cancellationToken)
    {
        _ = cancellationToken;

        var input = new ToolchainProbeInput
        {
            ProjectPath = ReadOptionalString(parameters, "projectPath"),
            Command = ReadRequiredString(parameters, "command"),
            GlobalJsonPath = ReadOptionalString(parameters, "globalJsonPath"),
            PinnedSdkVersion = ReadOptionalString(parameters, "pinnedSdkVersion"),
            Version = ReadCommandOutput(parameters, "version")
                ?? throw new RpcException(RpcException.InvalidParams, "'version' output is required."),
            SdkList = ReadCommandOutput(parameters, "sdkList")
                ?? throw new RpcException(RpcException.InvalidParams, "'sdkList' output is required."),
            Evaluation = ReadCommandOutput(parameters, "evaluation"),
            SdkCheckOutput = ReadOptionalString(parameters, "sdkCheckOutput"),
            PrivateSdkVersions = ReadStringArray(parameters, "privateSdkVersions"),
            CheckedAt = ReadRequiredString(parameters, "checkedAt"),
        };

        return Task.FromResult<object?>(ToolchainAnalysis.Evaluate(input));
    }

    private static CommandOutput? ReadCommandOutput(JsonElement parameters, string property)
    {
        if (parameters.ValueKind != JsonValueKind.Object
            || !parameters.TryGetProperty(property, out var element)
            || element.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        return new CommandOutput(
            ReadNullableInt32(element, "code"),
            ReadOptionalString(element, "stdout") ?? string.Empty,
            ReadOptionalString(element, "stderr") ?? string.Empty,
            ReadOptionalString(element, "spawnError"));
    }

    private static List<string> ReadStringArray(JsonElement parameters, string property)
    {
        var values = new List<string>();

        if (parameters.ValueKind == JsonValueKind.Object
            && parameters.TryGetProperty(property, out var array)
            && array.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in array.EnumerateArray())
            {
                if (element.ValueKind == JsonValueKind.String && element.GetString() is { } value)
                {
                    values.Add(value);
                }
            }
        }

        return values;
    }

    private static string ReadRequiredString(JsonElement parameters, string property)
    {
        var value = ReadOptionalString(parameters, property);
        return string.IsNullOrWhiteSpace(value)
            ? throw new RpcException(RpcException.InvalidParams, $"'{property}' is required.")
            : value;
    }

    private static string? ReadOptionalString(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadNullableInt32(JsonElement element, string property) =>
        element.ValueKind == JsonValueKind.Object
        && element.TryGetProperty(property, out var value)
        && value.ValueKind == JsonValueKind.Number
        && value.TryGetInt32(out var parsed)
            ? parsed
            : null;
}
